import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import type { WebhookDeliveryResult } from './automation-manager'

/**
 * Loopback HTTP endpoint GitHub webhooks are delivered to. Each automation
 * with a webhook trigger gets its own URL carrying a per-automation secret,
 * so one leaked token can only fire that one automation. Like the mobile
 * page, the server listens on this machine only; exposing it to GitHub is the
 * user's tunnel (tailscale funnel, ngrok, …).
 */

export const AUTOMATION_HOOKS_PORT = 4528

/** Largest body accepted: generous enough for payloads carrying diffs, small
 *  enough that a runaway sender cannot balloon the process. */
const MAX_BODY_BYTES = 1_000_000

export interface AutomationHookHost {
  deliver(automationId: string, token: string, eventHeader: string | undefined, body: unknown): Promise<WebhookDeliveryResult>
}

export interface AutomationHooksStatus {
  running: boolean
  url?: string
  error?: string
}

interface DeliveryTarget {
  automationId: string
  token: string
}

function parseTarget(pathname: string): DeliveryTarget | null {
  const match = /^\/hooks\/([A-Za-z0-9-]+)\/([A-Za-z0-9_-]+)$/.exec(pathname)
  if (!match) return null
  return { automationId: match[1], token: match[2] }
}

export class AutomationHooks {
  private server: Server | null = null
  private lastError?: string

  constructor(
    private readonly host: AutomationHookHost,
    private readonly port: number = AUTOMATION_HOOKS_PORT
  ) {}

  status(): AutomationHooksStatus {
    return {
      running: this.server !== null,
      url: this.server ? `http://127.0.0.1:${this.port}/hooks` : undefined,
      error: this.lastError
    }
  }

  buildUrl(automationId: string, token: string): string {
    return `${this.status().url ?? `http://127.0.0.1:${this.port}/hooks`}/${automationId}/${token}`
  }

  async start(): Promise<void> {
    if (this.server) return
    this.lastError = undefined
    const server = createServer((request, response) => void this.route(request, response))
    try {
      await new Promise<void>((resolveStart, reject) => {
        server.once('error', reject)
        server.listen(this.port, '127.0.0.1', () => resolveStart())
      })
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      return
    }
    this.server = server
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (server) await new Promise<void>((resolveStop) => server.close(() => resolveStop()))
  }

  private json(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = (request.url ?? '/').split('?')[0]
    if (!path.startsWith('/hooks/')) {
      this.json(response, 404, { error: 'not found' })
      return
    }
    if (request.method !== 'POST') {
      this.json(response, 405, { error: 'webhooks are delivered with POST' })
      return
    }
    const target = parseTarget(path)
    if (!target) {
      this.json(response, 404, { error: 'unknown hook' })
      return
    }
    let body = ''
    let overflow = false
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => {
      if (overflow) return
      body += chunk
      if (body.length > MAX_BODY_BYTES) {
        overflow = true
        body = ''
      }
    })
    request.on('end', () => {
      void (async () => {
        if (overflow) {
          this.json(response, 413, { ok: false, error: 'payload too large' })
          return
        }
        let payload: unknown
        try {
          payload = JSON.parse(body || '{}')
        } catch {
          this.json(response, 400, { ok: false, error: 'The payload must be JSON.' })
          return
        }
        const rawEvent = request.headers['x-github-event']
        const eventHeader = Array.isArray(rawEvent) ? rawEvent[0] : rawEvent
        try {
          const result = await this.host.deliver(target.automationId, target.token, eventHeader, payload)
          this.json(response, 200, { ok: true, result })
        } catch (error) {
          const status = typeof error === 'object' && error !== null && 'status' in error
            ? Number((error as { status?: unknown }).status) || 500
            : 500
          this.json(response, status, {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          })
        }
      })()
    })
  }
}
