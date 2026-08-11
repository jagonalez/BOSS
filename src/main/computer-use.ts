import { app, systemPreferences } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ComputerUsePermissions, ComputerUseStatus, PrivacyPane } from '@shared/ipc'
import type { Backend } from './backend/backend'

const MCP_SERVER_NAME = 'cua-driver'
const HOST_BUNDLE_ID = 'dev.ralf.app'

function resolveCuaBin(): string {
  const exe = process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver'
  if (process.env.CUA_DRIVER_BIN) return process.env.CUA_DRIVER_BIN
  if (!app.isPackaged) return exe
  const candidates = [
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
  return join(tmpdir(), `ralf-cua-${process.pid}.sock`)
}

export class ComputerUse {
  private backend: Backend | null = null
  private registered = false
  private enabled = false
  private error: string | undefined
  private daemon: ChildProcess | null = null
  private socket = ''

  onStatusChange?: (status: ComputerUseStatus) => void

  bind(backend: Backend | null): void {
    this.backend = backend
    if (this.enabled) void this.register()
    else this.emit()
  }

  get status(): ComputerUseStatus {
    return {
      supported: this.backend?.supportsMcp() ?? false,
      enabled: this.enabled,
      running: this.registered,
      error: this.error
    }
  }

  async permissions(): Promise<ComputerUsePermissions> {
    if (process.platform !== 'darwin') {
      return { available: false, accessibility: false, screenRecording: false }
    }
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
        return systemPreferences.isTrustedAccessibilityClient(true)
      }
      // Triggering a capture prompts macOS for Screen Recording, then re-probe.
      const { desktopCapturer } = await import('electron')
      await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
      return systemPreferences.getMediaAccessStatus('screen') === 'granted'
    } catch {
      return false
    }
  }

  async setEnabled(on: boolean): Promise<ComputerUseStatus> {
    this.enabled = on
    if (on) await this.register()
    else {
      await this.unregister()
    }
    this.emit()
    return this.status
  }

  private async unregister(): Promise<void> {
    this.registered = false
    this.error = undefined
    if (this.backend) await this.backend.unregisterMcpServer(MCP_SERVER_NAME).catch(() => {})
    this.stopDaemon()
  }

  private async register(): Promise<void> {
    this.registered = false
    this.error = undefined
    const backend = this.backend
    if (!backend) return
    if (!backend.supportsMcp()) {
      this.error = 'Computer use is not supported on this backend'
      this.emit()
      return
    }
    const bin = resolveCuaBin()
    if (!isFile(bin)) {
      this.error = 'cua-driver is not installed (see cua.ai/docs/how-to-guides/driver/install)'
      this.emit()
      return
    }
    this.stopDaemon()
    this.socket = socketPath()
    try {
      await this.startDaemon(bin)
      const ok = await backend
        .registerMcpServer(MCP_SERVER_NAME, {
          type: 'local',
          command: [bin, 'mcp', '--socket', this.socket],
          environment: { CUA_DRIVER_EMBEDDED: '1' }
        })
        .catch((err: unknown) => {
          this.error = String((err as Error).message ?? err)
          return false
        })
      this.registered = ok
      if (!ok && !this.error) this.error = 'Failed to register computer use'
    } catch (err) {
      this.error = String((err as Error).message ?? err)
      this.stopDaemon()
    }
    this.emit()
  }

  /** Spawn the embedded daemon as Ralf's child so TCC attributes to Ralf. */
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
        if (process.env.RALF_DEBUG) process.stderr.write(`[cua-driver] ${d}`)
      })
      child.on('exit', () => {
        this.daemon = null
        this.registered = false
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
    await this.unregister()
  }

  private emit(): void {
    this.onStatusChange?.(this.status)
  }

  async dispose(): Promise<void> {
    this.enabled = false
    await this.unregister()
  }
}
