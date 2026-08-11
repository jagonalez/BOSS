import { desktopCapturer, systemPreferences } from 'electron'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile, stat, unlink } from 'node:fs/promises'
import type { ComputerUsePermissions, ComputerUseStatus, PrivacyPane } from '@shared/ipc'
import type { Backend } from './backend/backend'

function probeScreenRecording(): Promise<boolean> {
  const out = join(tmpdir(), `ralf-perm-${Date.now()}.png`)
  return new Promise((resolve) => {
    execFile('screencapture', ['-x', out], { timeout: 8000 }, async (err) => {
      if (err) {
        resolve(false)
        return
      }
      try {
        const st = await stat(out)
        if (st.size < 10000) {
          resolve(false)
          return
        }
        const buf = await readFile(out)
        resolve(buf.length > 10000)
      } catch {
        resolve(false)
      } finally {
        void unlink(out).catch(() => {})
      }
    })
  })
}

export class ComputerUse {
  private backend: Backend | null = null
  private registered = false
  private enabled = false
  private error: string | undefined

  onStatusChange?: (status: ComputerUseStatus) => void

  constructor(private readonly helperPath: string) {}

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
    try {
      accessibility = systemPreferences.isTrustedAccessibilityClient(false)
    } catch {
      /* ignore */
    }
    const screenRecording = await probeScreenRecording()
    if (process.env.RALF_DEBUG) {
      process.stderr.write(
        `[computer-use] execPath=${process.execPath} pid=${process.pid} accessibility=${accessibility} screen=${systemPreferences.getMediaAccessStatus('screen')} screenProbe=${screenRecording}\n`
      )
    }
    return { available: true, accessibility, screenRecording }
  }

  async requestPermission(pane: PrivacyPane): Promise<boolean> {
    if (process.platform !== 'darwin') return false
    if (pane === 'accessibility') {
      try {
        return systemPreferences.isTrustedAccessibilityClient(true)
      } catch {
        return false
      }
    }
    try {
      // No direct API for Screen Recording; triggering a capture prompts macOS.
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
      return sources.length > 0 && (await probeScreenRecording())
    } catch {
      return false
    }
  }

  async setEnabled(on: boolean): Promise<ComputerUseStatus> {
    this.enabled = on
    if (on) await this.register()
    else {
      this.registered = false
      this.error = undefined
      if (this.backend) await this.backend.unregisterMcpServer('ralf-computer-use').catch(() => {})
    }
    this.emit()
    return this.status
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
    const ok = await backend
      .registerMcpServer('ralf-computer-use', {
        type: 'local',
        command: [process.execPath, this.helperPath],
        environment: { ELECTRON_RUN_AS_NODE: '1' }
      })
      .catch((err: unknown) => {
        this.error = String((err as Error).message ?? err)
        return false
      })
    this.registered = ok
    if (!ok && !this.error) this.error = 'Failed to register computer use'
    this.emit()
  }

  private emit(): void {
    this.onStatusChange?.(this.status)
  }

  async dispose(): Promise<void> {
    this.enabled = false
    this.registered = false
  }
}
