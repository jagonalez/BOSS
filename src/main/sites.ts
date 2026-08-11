import { app, safeStorage } from 'electron'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  chmodSync,
  createReadStream,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
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
  deploymentAccountId?: string
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
    if (!safeStorage.isEncryptionAvailable()) return {}
    const raw = readFileSync(secretFile())
    const text = safeStorage.decryptString(raw)
    const parsed = JSON.parse(text) as CloudflareSecret
    return { accountId: parsed.accountId, token: parsed.token }
  } catch {
    return {}
  }
}

function saveSecret(data: CloudflareSecret): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure credential storage is unavailable on this system')
  }
  const text = JSON.stringify(data)
  const path = secretFile()
  const payload = safeStorage.encryptString(text)
  writeFileSync(path, payload, { mode: 0o600 })
  chmodSync(path, 0o600)
}

function clearSecret(): void {
  try {
    unlinkSync(secretFile())
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep)
}

function sendText(res: ServerResponse, status: number, text: string, headers?: Record<string, string>): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers })
  res.end(text)
}

function createStaticServer(folder: string): Promise<HttpServer> {
  const root = realpathSync(folder)
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const port = portOf(server)
      const host = (req.headers.host || '').toLowerCase()
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
        sendText(res, 403, 'Forbidden')
        return
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendText(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' })
        return
      }

      let pathname: string
      try {
        const url = new URL(req.url || '/', `http://127.0.0.1:${port}`)
        pathname = decodeURIComponent(url.pathname)
      } catch {
        sendText(res, 400, 'Bad request')
        return
      }

      let filePath = resolve(root, `.${pathname}`)
      if (!isWithin(root, filePath)) {
        sendText(res, 403, 'Forbidden')
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
        filePath = realpathSync(filePath)
        if (!isWithin(root, filePath)) {
          sendText(res, 403, 'Forbidden')
          return
        }
        const st = statSync(filePath)
        if (st.isFile()) {
          const mime = MIME[extname(filePath).slice(1).toLowerCase()] || 'application/octet-stream'
          const headers = {
            'Content-Type': mime,
            'Cache-Control': 'no-cache',
            'Content-Length': String(st.size),
            'Cross-Origin-Resource-Policy': 'same-origin',
            'X-Content-Type-Options': 'nosniff'
          }
          if (req.method === 'HEAD') {
            res.writeHead(200, headers)
            res.end()
            return
          }
          const stream = createReadStream(filePath)
          stream.once('open', () => {
            res.writeHead(200, headers)
            stream.pipe(res)
          })
          stream.once('error', (err) => {
            if (!res.headersSent) sendText(res, 404, 'Not found')
            else res.destroy(err)
          })
          return
        }
      } catch {
        /* fall through to 404 */
      }
      sendText(res, 404, 'Not found')
    })
    const onListenError = (err: Error): void => rejectPromise(err)
    server.once('error', onListenError)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onListenError)
      resolvePromise(server)
    })
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

async function deleteCfWorker(token: string, accountId: string, scriptName: string): Promise<void> {
  const res = await fetch(`${CF_API}/accounts/${accountId}/workers/scripts/${scriptName}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  })
  if (res.status === 404) return
  const data = (await res.json().catch(() => ({}))) as CfResponse
  if (!res.ok || data.success === false) {
    const msg = data.errors?.[0]?.message || `Cloudflare delete failed (${res.status})`
    throw new Error(msg)
  }
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
  if (Object.keys(manifest).length === 0) throw new Error('The selected folder contains no deployable files')
  return { manifest, byHash }
}

function verificationFile(folder: string): { path: string; content: Buffer } {
  const index = join(folder, 'index.html')
  if (existsSync(index) && lstatSync(index).isFile()) {
    return { path: 'index.html', content: readFileSync(index) }
  }
  const find = (dir: string, base: string): { path: string; content: Buffer } | null => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      const rel = base ? `${base}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        const nested = find(abs, rel)
        if (nested) return nested
      } else if (entry.isFile()) {
        return { path: rel, content: readFileSync(abs) }
      }
    }
    return null
  }
  const result = find(folder, '')
  if (!result) throw new Error('The selected folder contains no deployable files')
  return result
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
          deploymentAccountId: persisted.deploymentAccountId,
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
    const requested = isAbsolute(folder) ? folder : resolve(this.projectPathProvider(), folder)
    if (!isDirectory(requested)) throw new Error(`Folder not found: ${requested}`)
    const abs = realpathSync(requested)
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
      site.deployedUrl = deployedUrl
      site.deploymentAccountId = secret.accountId
      this.persist()
      this.emit()
      await this.verifyDeploy(deployedUrl, site.folder)
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

  async unpublish(id: string): Promise<SiteInfo> {
    const site = this.sites.get(id)
    if (!site) throw new Error('Site not found')
    if (!site.deployedUrl) return this.toInfo(site)

    const secret = loadSecret()
    if (!secret.token || !secret.accountId) {
      throw new Error('Cloudflare is not configured. Reconnect the account that owns this deployment.')
    }
    const deploymentAccountId = site.deploymentAccountId ?? secret.accountId
    if (deploymentAccountId !== secret.accountId) {
      throw new Error(`Reconnect Cloudflare account ${deploymentAccountId} to unpublish this site.`)
    }

    site.status = 'unpublishing'
    site.error = undefined
    this.emit()
    try {
      await deleteCfWorker(secret.token, deploymentAccountId, site.scriptName)
      site.deployedUrl = undefined
      site.deploymentAccountId = undefined
      site.status = 'local'
    } catch (err) {
      site.status = 'error'
      site.error = `Unpublish failed: ${String((err as Error).message ?? err)}`
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
    clearSecret()
    return { configured: false }
  }

  private async publishFromAgent(folder: string, name?: string): Promise<SiteInfo> {
    const project = this.projectPathProvider()
    if (!isDirectory(project)) throw new Error('No active project is available')
    const projectRoot = realpathSync(project)
    const requested = isAbsolute(folder) ? folder : resolve(projectRoot, folder)
    if (!isDirectory(requested)) throw new Error(`Folder not found: ${requested}`)
    const candidate = realpathSync(requested)
    if (!isWithin(projectRoot, candidate)) {
      throw new Error('publish_site can only publish folders inside the active project')
    }
    return this.publish(candidate, name)
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
    return new Promise((resolvePromise, rejectPromise) => {
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
        let tooLarge = false
        req.setEncoding('utf8')
        req.on('data', (chunk: string) => {
          if (tooLarge) return
          body += chunk
          if (Buffer.byteLength(body) > 64 * 1024) {
            tooLarge = true
            res.writeHead(413, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'request too large' }))
          }
        })
        req.on('end', () => {
          if (tooLarge) return
          let payload: { folder?: string; name?: string }
          try {
            payload = JSON.parse(body || '{}')
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'bad request' }))
            return
          }
          if (typeof payload.folder !== 'string' || (payload.name !== undefined && typeof payload.name !== 'string')) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'invalid arguments' }))
            return
          }
          this.publishFromAgent(payload.folder, payload.name)
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
      const onListenError = (err: Error): void => rejectPromise(err)
      server.once('error', onListenError)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', onListenError)
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
    form.append('main.js', new Blob([WORKER_SCRIPT], { type: 'application/javascript+module' }), 'main.js')
    await cfRequest(token, `/accounts/${accountId}/workers/scripts/${site.scriptName}`, {
      method: 'PUT',
      body: form
    })

    await cfRequest(token, `/accounts/${accountId}/workers/scripts/${site.scriptName}/subdomain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, previews_enabled: false })
    })
    const sub = await cfRequest(token, `/accounts/${accountId}/workers/subdomain`)
    const subdomain = typeof sub?.subdomain === 'string' ? sub.subdomain.trim() : ''
    if (!subdomain) {
      throw new Error('Worker deployed, but this account has no workers.dev subdomain configured')
    }
    return `https://${site.scriptName}.${subdomain}.workers.dev/`
  }

  /** Cloudflare can report a successful deploy with an empty bucket; verify served content. */
  private async verifyDeploy(url: string, folder: string): Promise<void> {
    const expected = verificationFile(folder)
    const encodedPath = expected.path.split('/').map(encodeURIComponent).join('/')
    const candidate = new URL(encodedPath, url).toString()
    const expectedHash = createHash('sha256').update(expected.content).digest('hex').slice(0, 12)
    let lastResult = 'no response'
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        const res = await fetch(candidate)
        if (res.ok) {
          const body = Buffer.from(await res.arrayBuffer())
          if (body.equals(expected.content)) return
          const bodyHash = createHash('sha256').update(body).digest('hex').slice(0, 12)
          lastResult = `HTTP ${res.status}, ${body.length} bytes, sha256 ${bodyHash}`
        } else {
          lastResult = `HTTP ${res.status}`
        }
      } catch (err) {
        lastResult = `request failed: ${String((err as Error).message ?? err)}`
      }
      await new Promise((r) => setTimeout(r, 1500))
    }
    throw new Error(
      `Deployment verification failed at ${candidate}: expected ${expected.content.length} bytes, sha256 ${expectedHash}; received ${lastResult}`
    )
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
      deploymentAccountId: site.deploymentAccountId,
      lastPublishedAt: site.lastPublishedAt,
      status: site.status,
      error: site.error
    }
  }

  private emit(): void {
    this.onChanged?.(this.list())
  }
}
