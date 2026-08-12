import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { execFile } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { BackendRequest } from '../shared/backend'
import type { MobileAccessConfig, MobileAccessStatus } from '../shared/mobile'
import { MOBILE_PAGE } from './mobile-page'

/**
 * Serves the mobile site and a narrow API over loopback. Remote access is
 * delegated to the user's tailnet: `tailscale serve <port>` proxies this
 * server with TLS and tailnet identity, so nothing here listens beyond
 * 127.0.0.1.
 */

interface WebAccessHost {
  handle(request: BackendRequest): Promise<unknown>
  onEvent(callback: (event: Record<string, unknown>) => void): () => void
}

/** Only thread review/steering and automations. No settings, no MCP
 * connection management, no worktree removal, no thread deletion. */
const ALLOWED_REQUESTS = new Set<BackendRequest['type']>([
  'backend.list',
  'supervision.snapshot',
  'supervision.search',
  'supervision.acknowledge',
  'thread.list',
  'thread.get',
  'thread.messages',
  'thread.send',
  'thread.abort',
  'thread.todos',
  'thread.permission',
  'thread.diff',
  'automation.list',
  'automation.run',
  'automation.stop'
])

const READ_ONLY_REQUESTS = new Set<BackendRequest['type']>([
  'backend.list',
  'supervision.snapshot',
  'supervision.search',
  'thread.list',
  'thread.get',
  'thread.messages',
  'thread.todos',
  'thread.diff',
  'automation.list'
])

/** Event types the mobile page reacts to; the rest are desktop concerns. */
const FORWARDED_EVENTS = new Set([
  'session.created',
  'session.updated',
  'session.deleted',
  'session.status',
  'session.idle',
  'session.error',
  'message.updated',
  'message.part.updated',
  'message.part.created',
  'permission.asked',
  'permission.updated',
  'permission.replied',
  'automations.updated'
])

const DEFAULT_PORT = 4517

function tailscaleBin(): string | null {
  for (const candidate of ['/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function tailscaleRun(args: string[]): Promise<string> {
  const bin = tailscaleBin()
  if (!bin) return Promise.reject(new Error('Tailscale is not installed. Install it from tailscale.com, then re-enable.'))
  return new Promise((resolveRun, reject) => {
    execFile(bin, args, { encoding: 'utf8', timeout: 10_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || stdout || error.message).trim().slice(0, 300)))
      else resolveRun(String(stdout))
    })
  })
}

export class WebAccess {
  private config: MobileAccessConfig
  private server: Server | null = null
  private offEvents?: () => void
  private readonly sseClients = new Set<ServerResponse>()
  private lastError?: string
  private onChange?: () => void
  private tailscaleUrl?: string
  private tailscaleError?: string
  private tailscaleServing = false

  constructor(private readonly configFile: string, private readonly host: WebAccessHost) {
    this.config = this.load()
  }

  setOnChange(callback: () => void): void {
    this.onChange = callback
  }

  private load(): MobileAccessConfig {
    try {
      const parsed = JSON.parse(readFileSync(this.configFile, 'utf8')) as Partial<MobileAccessConfig>
      if (typeof parsed.token === 'string' && parsed.token.length >= 32) {
        return {
          enabled: Boolean(parsed.enabled),
          port: Number.isInteger(parsed.port) && (parsed.port as number) > 1024 ? (parsed.port as number) : DEFAULT_PORT,
          token: parsed.token,
          viewerToken: typeof parsed.viewerToken === 'string' && parsed.viewerToken.length >= 32
            ? parsed.viewerToken
            : randomBytes(24).toString('base64url'),
          tailscale: parsed.tailscale !== false
        }
      }
    } catch {
      /* First launch generates a fresh config below. */
    }
    return {
      enabled: false,
      port: DEFAULT_PORT,
      token: randomBytes(24).toString('base64url'),
      viewerToken: randomBytes(24).toString('base64url'),
      tailscale: true
    }
  }

  private save(): void {
    try {
      writeFileSync(this.configFile, JSON.stringify(this.config, null, 2))
    } catch {
      /* The toggle keeps working in memory if persistence is unavailable. */
    }
  }

  status(): MobileAccessStatus {
    return {
      ...this.config,
      running: this.server !== null,
      url: this.server ? `http://127.0.0.1:${this.config.port}` : undefined,
      error: this.lastError,
      tailscaleUrl: this.tailscaleUrl,
      tailscaleError: this.tailscaleError
    }
  }

  /**
   * Publish the loopback server on the user's tailnet. Plain-HTTP serve on
   * port 80 rather than HTTPS: tailnet traffic is WireGuard-encrypted anyway,
   * and HTTPS requires Let's Encrypt certificate provisioning that hangs on
   * some tailnets and macOS GUI builds (observed live). Failures surface
   * verbatim in Settings, since CLI flags vary across versions.
   */
  private async startTailscale(): Promise<void> {
    this.tailscaleUrl = undefined
    this.tailscaleError = undefined
    if (!this.config.tailscale) return
    try {
      await tailscaleRun(['serve', '--bg', '--http=80', String(this.config.port)])
      this.tailscaleServing = true
      const status = JSON.parse(await tailscaleRun(['status', '--json'])) as { Self?: { DNSName?: string } }
      const dns = status.Self?.DNSName?.replace(/\.$/, '')
      this.tailscaleUrl = dns ? `http://${dns}` : undefined
    } catch (error) {
      this.tailscaleError = error instanceof Error ? error.message : String(error)
    }
    this.onChange?.()
  }

  private async stopTailscale(): Promise<void> {
    if (!this.tailscaleServing) return
    this.tailscaleServing = false
    this.tailscaleUrl = undefined
    await tailscaleRun(['serve', 'reset']).catch(() => {
      /* Losing the reset only leaves a stale serve rule; re-enabling replaces it. */
    })
  }

  async start(): Promise<void> {
    if (this.config.enabled) await this.startServer()
  }

  async stop(): Promise<void> {
    await this.stopServer()
  }

  private async startServer(): Promise<void> {
    if (this.server) return
    this.lastError = undefined
    const server = createServer((request, response) => void this.route(request, response))
    try {
      await new Promise<void>((resolveStart, reject) => {
        server.once('error', reject)
        server.listen(this.config.port, '127.0.0.1', () => resolveStart())
      })
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.onChange?.()
      return
    }
    this.server = server
    this.offEvents = this.host.onEvent((event) => this.broadcast(event))
    this.onChange?.()
    void this.startTailscale()
  }

  private async stopServer(): Promise<void> {
    const server = this.server
    this.server = null
    this.offEvents?.()
    this.offEvents = undefined
    for (const client of this.sseClients) client.end()
    this.sseClients.clear()
    if (server) await new Promise<void>((resolveStop) => server.close(() => resolveStop()))
    await this.stopTailscale()
    this.onChange?.()
  }

  private access(request: IncomingMessage): 'control' | 'read-only' | null {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const supplied = request.headers.authorization?.startsWith('Bearer ')
      ? request.headers.authorization.slice(7)
      : url.searchParams.get('token') ?? ''
    const given = Buffer.from(supplied)
    for (const [role, token] of [['control', this.config.token], ['read-only', this.config.viewerToken]] as const) {
      const expected = Buffer.from(token)
      if (given.length === expected.length && timingSafeEqual(given, expected)) return role
    }
    return null
  }

  private broadcast(event: Record<string, unknown>): void {
    if (this.sseClients.size === 0) return
    if (!FORWARDED_EVENTS.has(String(event.type ?? ''))) return
    const payload = `data: ${JSON.stringify(event)}\n\n`
    for (const client of this.sseClients) client.write(payload)
  }

  private json(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = (request.url ?? '/').split('?')[0]
    if (path === '/' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(MOBILE_PAGE)
      return
    }
    const access = this.access(request)
    if (!access) {
      this.json(response, 401, { error: 'unauthorized' })
      return
    }
    if (path === '/api/access' && request.method === 'GET') {
      this.json(response, 200, { role: access })
      return
    }
    if (path === '/api/events' && request.method === 'GET') {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      })
      response.write(': connected\n\n')
      this.sseClients.add(response)
      request.on('close', () => this.sseClients.delete(response))
      return
    }
    if (path === '/api/request' && request.method === 'POST') {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => {
        body += chunk
        if (body.length > 256_000) request.destroy()
      })
      request.on('end', () => {
        void (async () => {
          try {
            const payload = JSON.parse(body) as BackendRequest
            if (!ALLOWED_REQUESTS.has(payload.type)) {
              this.json(response, 403, { error: `"${payload.type}" is not available over mobile access.` })
              return
            }
            if (access === 'read-only' && !READ_ONLY_REQUESTS.has(payload.type)) {
              this.json(response, 403, { error: `"${payload.type}" requires a control token.` })
              return
            }
            const result = await this.host.handle(payload)
            this.json(response, 200, { ok: true, result: result ?? null })
          } catch (error) {
            this.json(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        })()
      })
      return
    }
    this.json(response, 404, { error: 'not found' })
  }

  async handle(request: BackendRequest): Promise<unknown> {
    switch (request.type) {
      case 'mobile.status':
        return this.status()
      case 'mobile.set': {
        if (request.patch.enabled !== undefined) this.config.enabled = request.patch.enabled
        if (request.patch.tailscale !== undefined) this.config.tailscale = request.patch.tailscale
        if (request.patch.port !== undefined && Number.isInteger(request.patch.port) && request.patch.port > 1024 && request.patch.port < 65_536) {
          this.config.port = request.patch.port
        }
        if (request.patch.regenerateToken) this.config.token = randomBytes(24).toString('base64url')
        if (request.patch.regenerateViewerToken) this.config.viewerToken = randomBytes(24).toString('base64url')
        this.save()
        await this.stopServer()
        if (this.config.enabled) await this.startServer()
        return this.status()
      }
      default:
        throw new Error(`Unsupported mobile request: ${request.type}`)
    }
  }
}
