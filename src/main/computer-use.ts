import { app, systemPreferences } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ComputerUsePermissions, ComputerUseStatus, PrivacyPane } from '@shared/ipc'
import type { AgentToolResult } from '@shared/qa'

const HOST_BUNDLE_ID = 'dev.boss.app'
const ALLOWED_TOOLS = new Set([
  'list_apps',
  'list_windows',
  'get_window_state',
  'get_desktop_state',
  'screenshot',
  'zoom',
  'click',
  'type_text',
  'press_key',
  'hotkey',
  'scroll',
  'wait'
])

function resolveCuaBin(): string {
  const exe = process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver'
  if (process.env.CUA_DRIVER_BIN) return process.env.CUA_DRIVER_BIN
  if (!app.isPackaged) return exe
  const candidates = [
    // Shipped flat. A nested .app signed by another team (Cua AI) sent
    // notarization into manual review, and the bundle's Info.plist made the
    // signature fragile: a stray cp -R once stripped it and Apple rejected the
    // build. The binary carries its own signature, which flattening preserves.
    join(process.resourcesPath ?? '', 'cua-driver', exe),
    join(app.getAppPath(), 'resources', 'cua-driver', exe),
    // Older layouts and a locally installed driver.
    join(process.resourcesPath ?? '', 'cua-driver', 'CuaDriver.app', 'Contents', 'MacOS', exe),
    join(app.getAppPath(), 'resources', 'cua-driver', 'CuaDriver.app', 'Contents', 'MacOS', exe),
    '/Applications/CuaDriver.app/Contents/MacOS/cua-driver'
  ]
  for (const c of candidates) {
    if (isFile(c)) return c
  }
  return exe
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

function isSocketReady(p: string): boolean {
  try {
    const st = statSync(p)
    return st.isSocket() || st.isFile()
  } catch {
    return false
  }
}

function socketPath(): string {
  return join(tmpdir(), `boss-cua-${process.pid}.sock`)
}

export class ComputerUse {
  private enabled = false
  private error: string | undefined
  private daemon: ChildProcess | null = null
  private socket = ''

  onStatusChange?: (status: ComputerUseStatus) => void

  get status(): ComputerUseStatus {
    return {
      supported: true,
      enabled: this.enabled,
      running: Boolean(this.daemon && this.socket && isSocketReady(this.socket)),
      error: this.error
    }
  }

  async permissions(): Promise<ComputerUsePermissions> {
    if (process.platform !== 'darwin') {
      return { available: false, accessibility: false, screenRecording: false }
    }
    // In embedded mode the daemon runs as BOSS's child, so BOSS's own TCC
    // grants ARE the driver's grants — systemPreferences is authoritative.
    let accessibility = false
    let screenRecording = false
    try {
      accessibility = systemPreferences.isTrustedAccessibilityClient(false)
      screenRecording = systemPreferences.getMediaAccessStatus('screen') === 'granted'
    } catch {
      /* ignore */
    }
    return { available: true, accessibility, screenRecording }
  }

  async requestPermission(pane: PrivacyPane): Promise<boolean> {
    if (process.platform !== 'darwin') return false
    try {
      if (pane === 'accessibility') {
        systemPreferences.isTrustedAccessibilityClient(true)
      } else {
        // Triggering a capture prompts macOS for Screen Recording.
        const { desktopCapturer } = await import('electron')
        await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
      }
      const perms = await this.permissions()
      return pane === 'accessibility' ? perms.accessibility : perms.screenRecording
    } catch {
      return false
    }
  }

  async setEnabled(on: boolean): Promise<ComputerUseStatus> {
    this.enabled = on
    if (on) await this.start()
    else this.stopDaemon()
    this.emit()
    return this.status
  }

  private async start(): Promise<void> {
    this.error = undefined
    const bin = resolveCuaBin()
    this.stopDaemon()
    this.socket = socketPath()
    try {
      await this.startDaemon(bin)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      this.error = code === 'ENOENT'
        ? 'cua-driver is not installed (see cua.ai/docs/how-to-guides/driver/install)'
        : String((err as Error).message ?? err)
      this.stopDaemon()
    }
    this.emit()
  }

  async call(tool: string, args: Record<string, unknown>): Promise<AgentToolResult> {
    if (!ALLOWED_TOOLS.has(tool)) throw new Error(`Computer tool “${tool}” is not available in BOSS's scoped QA surface.`)
    if (!this.enabled || !this.daemon || !isSocketReady(this.socket)) {
      throw new Error('Computer Use is disabled. Enable Automatic QA or turn on Computer Use before trying again.')
    }
    const bin = resolveCuaBin()
    const screenshotDir = join(tmpdir(), 'boss-qa')
    mkdirSync(screenshotDir, { recursive: true })
    const screenshotPath = join(screenshotDir, `${randomUUID()}.png`)
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(bin, [
        'call',
        tool,
        JSON.stringify(args),
        '--socket', this.socket,
        '--screenshot-out-file', screenshotPath
      ], {
        env: { ...process.env, CUA_DRIVER_EMBEDDED: '1', CUA_DRIVER_HOST_BUNDLE_ID: HOST_BUNDLE_ID },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        reject(new Error(`Computer tool ${tool} timed out.`))
      }, 60_000)
      child.stdout?.on('data', (chunk) => { if (stdout.length < 2_000_000) stdout += String(chunk) })
      child.stderr?.on('data', (chunk) => { if (stderr.length < 100_000) stderr += String(chunk) })
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve(stdout.trim() || `Computer tool ${tool} completed.`)
        else reject(new Error(stderr.trim() || stdout.trim() || `Computer tool ${tool} failed with exit code ${code}.`))
      })
    })
    let image: AgentToolResult['image']
    try {
      image = { mimeType: 'image/png', data: readFileSync(screenshotPath).toString('base64') }
    } catch {
      /* Most computer tools do not return an image. */
    } finally {
      try { unlinkSync(screenshotPath) } catch { /* ignore */ }
    }
    return { __bossToolResult: true, text: output.slice(0, 80_000), image }
  }

  /** Spawn the embedded daemon as BOSS's child so TCC attributes to BOSS. */
  private startDaemon(bin: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, ['serve', '--embedded', '--socket', this.socket], {
        env: {
          ...process.env,
          CUA_DRIVER_EMBEDDED: '1',
          CUA_DRIVER_HOST_BUNDLE_ID: HOST_BUNDLE_ID
        },
        stdio: ['ignore', 'ignore', 'pipe']
      })
      this.daemon = child
      child.stderr?.on('data', (d) => {
        if (process.env.BOSS_DEBUG) process.stderr.write(`[cua-driver] ${d}`)
      })
      child.on('exit', () => {
        this.daemon = null
        this.emit()
      })
      child.on('error', (err) => {
        this.daemon = null
        reject(err)
      })
      // Wait until the daemon socket is accepting.
      const deadline = Date.now() + 15000
      const poll = (): void => {
        if (isSocketReady(this.socket)) {
          resolve()
          return
        }
        if (Date.now() > deadline || !this.daemon) {
          reject(new Error('cua-driver daemon did not start'))
          return
        }
        setTimeout(poll, 200)
      }
      setTimeout(poll, 300)
    })
  }

  private stopDaemon(): void {
    if (this.daemon) {
      this.daemon.kill('SIGTERM')
      this.daemon = null
    }
  }

  /** Emergency stop — kill the daemon and drop the MCP registration. */
  async emergencyStop(): Promise<void> {
    this.enabled = false
    this.stopDaemon()
    this.emit()
  }

  private emit(): void {
    this.onStatusChange?.(this.status)
  }

  async dispose(): Promise<void> {
    this.enabled = false
    this.stopDaemon()
  }
}
