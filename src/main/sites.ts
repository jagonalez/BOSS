import { app, safeStorage } from 'electron'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { basename, extname, isAbsolute, join, resolve, sep } from 'node:path'
import type { CloudflareSettings, SiteInfo } from '@shared/ipc'
import type { Backend } from './backend/backend'

const MCP_SERVER_NAME = 'ralf-sites'
const CF_API = 'https://api.cloudflare.com/client/v4'

const MIME: Record<string, string> = {
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  json: 'application/json',
  map: 'application/json',
  txt: 'text/plain',
  md: 'text/markdown',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  wasm: 'application/wasm',
  pdf: 'application/pdf',
  xml: 'application/xml',
  webmanifest: 'application/manifest+json',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  webm: 'video/webm'
}

const WORKER_SCRIPT = `export default {
  async fetch(request, env) {
    return env.ASSETS.fetch(request)
  }
}
`

interface PersistedSite {
  id: string
  name: string
  folder: string
  scriptName: string
  deployedUrl?: string
  lastPublishedAt: number
}

interface ManagedSite extends SiteInfo {
  server: HttpServer
}

interface CloudflareSecret {
  accountId?: string
  token?: string
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'site'
  )
}

function registryFile(): string {
  return join(app.getPath('userData'), 'sites.json')
}

function secretFile(): string {
  return join(app.getPath('userData'), 'sites.secret')
}

function loadRegistry(): PersistedSite[] {
  try {
    const parsed = JSON.parse(readFileSync(registryFile(), 'utf8')) as { sites?: PersistedSite[] }
    return Array.isArray(parsed.sites) ? parsed.sites : []
  } catch {
    return []
  }
}

function saveRegistry(sites: PersistedSite[]): void {
  try {
    writeFileSync(registryFile(), JSON.stringify({ sites }, null, 2))
  } catch {
    /* ignore */
  }
}

function loadSecret(): CloudflareSecret {
  try {
    const raw = readFileSync(secretFile())
    const text = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8')
    const parsed = JSON.parse(text) as CloudflareSecret
    return { accountId: parsed.accountId, token: parsed.token }
  } catch {
    return {}
  }
}

function saveSecret(data: CloudflareSecret): void {
  const text = JSON.stringify(data)
  try {
    const payload = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(text) : Buffer.from(text, 'utf8')
    writeFileSync(secretFile(), payload)
  } catch {
    /* ignore */
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

function createStaticServer(folder: string): Promise<HttpServer> {
  const root = resolve(folder)
  return new Promise((resolvePromise) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || '/', 'http://localhost')
      let pathname = decodeURIComponent(url.pathname)
      let filePath = join(root, pathname)
      if (!filePath.startsWith(root + sep) && filePath !== root) {
        res.writeHead(403, { 'Content-Type': 'text/plain' })
        res.end('Forbidden')
        return
      }
      try {
        if (statSync(filePath).isDirectory()) filePath = join(filePath, 'index.html')
      } catch {
        if (!extname(pathname)) {
          const idx = join(root, 'index.html')
          if (existsSync(idx)) filePath = idx
        }
      }
      try {
        const st = statSync(filePath)
        if (st.isFile()) {
          const mime = MIME[extname(filePath).slice(1).toLowerCase()] || 'application/octet-stream'
          res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache', 'Content-Length': st.size })
          createReadStream(filePath).pipe(res)
          return
        }
      } catch {
        /* fall through to 404 */
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not found')
    })
    server.listen(0, '127.0.0.1', () => resolvePromise(server))
  })
}

function portOf(server: HttpServer): number {
  return (server.address() as AddressInfo).port
}

interface CfResponse {
  success?: boolean
  errors?: Array<{ message?: string }>
  result?: any
}

async function cfRequest(token: string, path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${CF_API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init?.headers || {}) }
  })
  const data = (await res.json().catch(() => ({}))) as CfResponse
  if (!res.ok || data.success === false) {
    const msg = data.errors?.[0]?.message || `Cloudflare request failed (${res.status})`
    throw new Error(msg)
  }
  return data.result
}

interface ManifestBuild {
  manifest: Record<string, { hash: string; size: number }>
  byHash: Map<string, { abs: string; mime: string }>
}

function buildManifest(folder: string): ManifestBuild {
  const manifest: ManifestBuild['manifest'] = {}
  const byHash = new Map<string, { abs: string; mime: string }>()
  const walk = (dir: string, base: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      const rel = base ? `${base}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        walk(abs, rel)
      } else if (entry.isFile()) {
        const content = readFileSync(abs)
        const ext = extname(rel).slice(1)
        const hash = createHash('sha256')
          .update(content.toString('base64') + ext)
          .digest('hex')
          .slice(0, 32)
        manifest[`/${rel}`] = { hash, size: content.length }
        byHash.set(hash, { abs, mime: MIME[ext.toLowerCase()] || 'application/octet-stream' })
      }
    }
  }
  walk(folder, '')
  return { manifest, byHash }
}

export class SitesManager {
  private sites = new Map<string, ManagedSite>()
  private controlServer: HttpServer | null = null
  private controlPort = 0
  private controlSecret = ''
  private backend: Backend | null = null
  private registered = false

  onChanged?: (sites: SiteInfo[]) => void

  constructor(private readonly projectPathProvider: () => string) {}

  list(): SiteInfo[] {
    return [...this.sites.values()]
      .map((s) => this.toInfo(s))
      .sort((a, b) => b.lastPublishedAt - a.lastPublishedAt)
  }

  bind(backend: Backend | null): void {
    this.backend = backend
    this.registered = false
    if (backend?.supportsMcp()) void this.registerMcp()
  }

  async start(): Promise<void> {
    await this.startControlServer()
    for (const persisted of loadRegistry()) {
      if (!isDirectory(persisted.folder)) continue
      try {
        const server = await createStaticServer(persisted.folder)
        this.sites.set(persisted.id, {
          id: persisted.id,
          name: persisted.name,
          folder: persisted.folder,
          localUrl: `http://127.0.0.1:${portOf(server)}`,
          port: portOf(server),
          scriptName: persisted.scriptName,
          deployedUrl: persisted.deployedUrl,
          lastPublishedAt: persisted.lastPublishedAt,
          status: persisted.deployedUrl ? 'live' : 'local',
          server
        })
      } catch {
        /* skip sites whose folder is no longer servable */
      }
    }
    this.emit()
  }

  async stop(): Promise<void> {
    this.controlServer?.close()
    this.controlServer = null
    for (const site of this.sites.values()) site.server.close()
    this.sites.clear()
    if (this.backend) await this.backend.unregisterMcpServer(MCP_SERVER_NAME).catch(() => {})
    this.registered = false
  }

  async publish(folder: string, name?: string): Promise<SiteInfo> {
    const abs = isAbsolute(folder) ? folder : resolve(this.projectPathProvider(), folder)
    if (!isDirectory(abs)) throw new Error(`Folder not found: ${abs}`)
    const siteName = (name || '').trim() || basename(abs) || 'site'
    const server = await createStaticServer(abs)
    const site: ManagedSite = {
      id: `site-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
      name: siteName,
      folder: abs,
      localUrl: `http://127.0.0.1:${portOf(server)}`,
      port: portOf(server),
      scriptName: `${slugify(siteName)}-${randomBytes(3).toString('hex')}`,
      lastPublishedAt: Date.now(),
      status: 'local',
      server
    }
    this.sites.set(site.id, site)
    this.persist()
    this.emit()
    return this.toInfo(site)
  }

  async remove(id: string): Promise<void> {
    const site = this.sites.get(id)
    if (!site) return
    site.server.close()
    this.sites.delete(id)
    this.persist()
    this.emit()
  }

  async deploy(id: string): Promise<SiteInfo> {
    const site = this.sites.get(id)
    if (!site) throw new Error('Site not found')
    const secret = loadSecret()
    if (!secret.token || !secret.accountId) {
      throw new Error('Cloudflare is not configured. Add your API token and account ID in Settings → Sites.')
    }
    site.status = 'deploying'
    site.error = undefined
    this.emit()
    try {
      const deployedUrl = await this.deployToCloudflare(site, secret.token, secret.accountId)
      await this.verifyDeploy(deployedUrl, site.folder)
      site.deployedUrl = deployedUrl
      site.status = 'live'
      site.lastPublishedAt = Date.now()
    } catch (err) {
      site.status = 'error'
      site.error = String((err as Error).message ?? err)
      this.persist()
      this.emit()
      throw err
    }
    this.persist()
    this.emit()
    return this.toInfo(site)
  }

  async cloudflareGet(): Promise<CloudflareSettings> {
    const secret = loadSecret()
    return { configured: Boolean(secret.token && secret.accountId), accountId: secret.accountId }
  }

  async cloudflareSet(token: string, accountId: string): Promise<CloudflareSettings> {
    const cleanToken = token.trim()
    const cleanAccount = accountId.trim()
    if (!cleanToken || !cleanAccount) throw new Error('Token and account ID are required')
    saveSecret({ token: cleanToken, accountId: cleanAccount })
    return { configured: true, accountId: cleanAccount }
  }

  async cloudflareClear(): Promise<CloudflareSettings> {
    saveSecret({})
    return { configured: false }
  }

  private async registerMcp(): Promise<void> {
    const backend = this.backend
    if (!backend || !backend.supportsMcp() || this.registered || this.controlPort === 0) return
    const script = this.resolveMcpScript()
    if (!script) return
    const ok = await backend
      .registerMcpServer(MCP_SERVER_NAME, {
        type: 'local',
        command: [process.execPath, script],
        environment: {
          ELECTRON_RUN_AS_NODE: '1',
          RALF_SITES_CONTROL_URL: `http://127.0.0.1:${this.controlPort}`,
          RALF_SITES_SECRET: this.controlSecret
        }
      })
      .catch(() => false)
    this.registered = ok
  }

  private resolveMcpScript(): string {
    const candidates = [
      join(app.getAppPath(), 'resources', 'sites-mcp', 'index.mjs'),
      join(process.resourcesPath ?? '', 'sites-mcp', 'index.mjs')
    ]
    for (const c of candidates) {
      try {
        if (statSync(c).isFile()) return c
      } catch {
        /* try next */
      }
    }
    return candidates[0]
  }

  private startControlServer(): Promise<void> {
    this.controlSecret = randomBytes(32).toString('hex')
    return new Promise((resolvePromise) => {
      const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST' || req.url !== '/publish') {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'not found' }))
          return
        }
        const auth = req.headers.authorization || ''
        if (!safeEqual(auth, `Bearer ${this.controlSecret}`)) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'unauthorized' }))
          return
        }
        let body = ''
        req.on('data', (chunk) => (body += chunk))
        req.on('end', () => {
          let payload: { folder?: string; name?: string }
          try {
            payload = JSON.parse(body || '{}')
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'bad request' }))
            return
          }
          this.publish(payload.folder || '', payload.name)
            .then((site) => {
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ id: site.id, name: site.name, url: site.localUrl }))
            })
            .catch((err) => {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: String((err as Error).message ?? err) }))
            })
        })
      })
      server.on('error', () => resolvePromise())
      server.listen(0, '127.0.0.1', () => {
        this.controlPort = portOf(server)
        this.controlServer = server
        resolvePromise()
      })
    })
  }

  private async deployToCloudflare(site: ManagedSite, token: string, accountId: string): Promise<string> {
    const { manifest, byHash } = buildManifest(site.folder)
    const session = await cfRequest(
      token,
      `/accounts/${accountId}/workers/scripts/${site.scriptName}/assets-upload-session`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ manifest })
      }
    )
    let completionJwt: string = session.jwt
    const buckets: string[][] = Array.isArray(session.buckets) ? session.buckets : []

    for (const bucket of buckets) {
      const form = new FormData()
      for (const hash of bucket) {
        const file = byHash.get(hash)
        if (!file) continue
        form.append(hash, new Blob([readFileSync(file.abs).toString('base64')], { type: file.mime }))
      }
      const res = await fetch(`${CF_API}/accounts/${accountId}/workers/assets/upload?base64=true`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.jwt}` },
        body: form
      })
      const data = (await res.json().catch(() => ({}))) as CfResponse
      if (!res.ok || data.success === false) {
        throw new Error(data.errors?.[0]?.message || `Asset upload failed (${res.status})`)
      }
      if (data.result?.jwt) completionJwt = data.result.jwt
    }

    const metadata = {
      main_module: 'main.js',
      assets: {
        jwt: completionJwt,
        config: {
          html_handling: 'auto-trailing-slash',
          not_found_handling: 'single-page-application'
        }
      },
      compatibility_date: new Date().toISOString().slice(0, 10),
      bindings: [{ name: 'ASSETS', type: 'assets' }]
    }
    const form = new FormData()
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }))
    form.append('main.js', new Blob([WORKER_SCRIPT], { type: 'application/javascript+module' }))
    await cfRequest(token, `/accounts/${accountId}/workers/scripts/${site.scriptName}`, {
      method: 'PUT',
      body: form
    })

    let subdomain = ''
    try {
      const sub = await cfRequest(token, `/accounts/${accountId}/workers/subdomain`)
      subdomain = sub?.subdomain || ''
    } catch {
      /* workers.dev subdomain may not be enabled */
    }
    return subdomain
      ? `https://${site.scriptName}.${subdomain}.workers.dev/`
      : `https://${site.scriptName}.workers.dev/`
  }

  /** Cloudflare can report a successful deploy with an empty bucket; verify served content. */
  private async verifyDeploy(url: string, folder: string): Promise<void> {
    const expected = existsSync(join(folder, 'index.html')) ? readFileSync(join(folder, 'index.html'), 'utf8') : null
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        const candidates = [url, `${url}index.html`]
        for (const candidate of candidates) {
          const res = await fetch(candidate)
          if (res.ok) {
            const body = await res.text()
            if (expected === null ? body.length > 0 : body === expected) return
          }
        }
      } catch {
        /* not propagated yet */
      }
      await new Promise((r) => setTimeout(r, 1500))
    }
    throw new Error('Deployment reported success but served content does not match. Retry the deploy.')
  }

  private persist(): void {
    saveRegistry([...this.sites.values()].map((s) => this.toInfo(s)))
  }

  private toInfo(site: ManagedSite): SiteInfo {
    return {
      id: site.id,
      name: site.name,
      folder: site.folder,
      localUrl: site.localUrl,
      port: site.port,
      scriptName: site.scriptName,
      deployedUrl: site.deployedUrl,
      lastPublishedAt: site.lastPublishedAt,
      status: site.status,
      error: site.error
    }
  }

  private emit(): void {
    this.onChanged?.(this.list())
  }
}
