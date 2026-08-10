import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import net from 'node:net'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { ServerInfo } from '@shared/ipc'
import { saveState } from './state-store'

interface Health {
  healthy: boolean
  version: string
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo
      srv.close(() => resolve(addr.port))
    })
  })
}

function resolveOpenCodeBin(): string {
  const exe = process.platform === 'win32' ? 'opencode.exe' : 'opencode'
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN
  if (!app.isPackaged) return exe
  const candidates = [
    join(process.resourcesPath ?? '', 'opencode', exe),
    join(app.getAppPath(), 'resources', 'opencode', exe)
  ]
  for (const c of candidates) {
    try {
      if (statSync(c).isFile()) return c
    } catch {
      /* skip */
    }
  }
  return exe
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

async function fetchHealth(base: string, auth: string): Promise<Health | null> {
  try {
    const res = await fetch(`${base}/global/health`, {
      headers: { Authorization: auth }
    })
    if (!res.ok) {
      if (process.env.RALF_DEBUG) {
        process.stderr.write(`[opencode] health status ${res.status}\n`)
      }
      return null
    }
    const json = (await res.json()) as { healthy?: boolean; version?: string }
    return { healthy: Boolean(json.healthy), version: String(json.version ?? '') }
  } catch (err) {
    if (process.env.RALF_DEBUG) {
      const cause = (err as Error).cause as { code?: string } | undefined
      process.stderr.write(`[opencode] health fetch error: ${(err as Error).message} code=${cause?.code}\n`)
    }
    return null
  }
}

export class OpenCodeServer {
  private proc: ChildProcess | null = null
  private port = 0
  private password = ''
  private healthy = false
  private version = ''
  private stopping = false
  private suppressRestart = false
  private restartTimer: NodeJS.Timeout | null = null
  private attempts = 0
  private cwd = app.getPath('home')
  private fallbackToPath = false

  onStatusChange?: (info: ServerInfo) => void

  get info(): ServerInfo {
    return {
      port: this.port,
      url: this.baseUrl,
      version: this.version,
      healthy: this.healthy
    }
  }

  get projectPath(): string {
    return this.cwd
  }

  setInitialCwd(path: string): void {
    if (isDirectory(path)) this.cwd = path
  }

  async setProject(path: string): Promise<void> {
    if (!path || path === this.cwd) return
    if (process.env.RALF_SERVER_URL) {
      throw new Error('cannot switch project while connected to an external server')
    }
    if (!isDirectory(path)) {
      throw new Error(`project directory does not exist: ${path}`)
    }
    this.cwd = path
    saveState({ projectPath: path })
    const proc = this.proc
    if (proc) {
      this.suppressRestart = true
      this.healthy = false
      this.emitStatus()
      await new Promise<void>((resolve) => {
        proc.once('exit', () => resolve())
        proc.kill('SIGTERM')
        setTimeout(() => resolve(), 1500)
      })
      this.suppressRestart = false
    }
    await this.start()
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`
  }

  get authHeader(): string {
    return `Basic ${Buffer.from(`opencode:${this.password}`).toString('base64')}`
  }

  async start(): Promise<void> {
    this.suppressRestart = false
    const extUrl = process.env.RALF_SERVER_URL
    const extPass = process.env.RALF_SERVER_PASSWORD
    if (extUrl && extPass) {
      const parsed = new URL(extUrl)
      this.port = Number(parsed.port || 80)
      this.password = extPass
      if (process.env.RALF_DEBUG) process.stderr.write(`[opencode] connecting to external server ${extUrl}\n`)
      await this.waitForHealth()
      return
    }
    this.port = await getFreePort()
    this.password = randomBytes(32).toString('hex')
    const bin = this.fallbackToPath ? (process.platform === 'win32' ? 'opencode.exe' : 'opencode') : resolveOpenCodeBin()
    const proc = spawn(bin, ['serve', '--port', String(this.port), '--hostname', '127.0.0.1'], {
      cwd: isDirectory(this.cwd) ? this.cwd : app.getPath('home'),
      env: {
        ...process.env,
        OPENCODE_SERVER_PASSWORD: this.password,
        OPENCODE_SERVER_USERNAME: 'opencode'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    this.proc = proc
    if (process.env.RALF_DEBUG) process.stderr.write(`[opencode] spawning ${bin} on port ${this.port} cwd=${this.cwd}\n`)
    proc.stdout?.on('data', (d) => {
      if (process.env.RALF_DEBUG) process.stderr.write(`[opencode:out] ${d}`)
    })
    proc.stderr?.on('data', (d) => {
      if (process.env.RALF_DEBUG) process.stderr.write(`[opencode] ${d}`)
    })
    proc.on('error', (err) => {
      this.proc = null
      this.healthy = false
      this.emitStatus()
      if (this.stopping || this.suppressRestart) return
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        this.fallbackToPath = true
      }
      if (process.env.RALF_DEBUG) process.stderr.write(`[opencode] spawn error: ${err.message}\n`)
      this.scheduleRestart(1, null)
    })
    proc.on('exit', (code, signal) => {
      this.proc = null
      this.healthy = false
      this.emitStatus()
      if (!this.stopping && !this.suppressRestart) this.scheduleRestart(code, signal)
    })
    await this.waitForHealth()
  }

  private scheduleRestart(code: number | null, signal: NodeJS.Signals | null): void {
    this.attempts += 1
    const delay = Math.min(1000 * 2 ** this.attempts, 15000)
    if (process.env.RALF_DEBUG) {
      process.stderr.write(`[opencode] exited (${code ?? signal}), restarting in ${delay}ms\n`)
    }
    this.restartTimer = setTimeout(() => {
      void this.start()
    }, delay)
  }

  private async waitForHealth(): Promise<void> {
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      const health = await fetchHealth(this.baseUrl, this.authHeader)
      if (health) {
        this.healthy = health.healthy
        this.version = health.version
        this.attempts = 0
        this.fallbackToPath = false
        this.emitStatus()
        return
      }
      await new Promise((r) => setTimeout(r, 200))
    }
    if (process.env.RALF_DEBUG) process.stderr.write('[opencode] health check timed out\n')
    this.emitStatus()
  }

  private emitStatus(): void {
    this.onStatusChange?.(this.info)
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.restartTimer) clearTimeout(this.restartTimer)
    const proc = this.proc
    this.proc = null
    if (proc) {
      await new Promise<void>((resolve) => {
        proc.once('exit', () => resolve())
        proc.kill('SIGTERM')
        setTimeout(() => resolve(), 2000)
      })
    }
  }
}
