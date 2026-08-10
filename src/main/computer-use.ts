import { utilityProcess, type UtilityProcess } from 'electron'
import type { ComputerUseStatus } from '@shared/ipc'
import type { ApiClient } from './api-client'

export class ComputerUse {
  private helper: UtilityProcess | null = null
  private registered = false

  onStatusChange?: (status: ComputerUseStatus) => void

  constructor(
    private readonly api: ApiClient,
    private readonly helperPath: string
  ) {}

  get status(): ComputerUseStatus {
    const running = this.helper !== null
    return { enabled: running, running }
  }

  async setEnabled(on: boolean): Promise<ComputerUseStatus> {
    if (on && !this.helper) {
      await this.start()
    } else if (!on && this.helper) {
      this.stop()
    }
    this.onStatusChange?.(this.status)
    return this.status
  }

  private async start(): Promise<void> {
    try {
      const child = utilityProcess.fork(this.helperPath, [], { stdio: 'ignore' })
      child.on('exit', () => {
        this.helper = null
        this.registered = false
        this.onStatusChange?.(this.status)
      })
      this.helper = child
      if (!this.registered) {
        const res = await this.api.request({
          method: 'POST',
          path: '/mcp',
          body: {
            name: 'ralf-computer-use',
            config: {
              type: 'local',
              command: [process.execPath, this.helperPath],
              environment: {}
            }
          }
        })
        this.registered = res.status >= 200 && res.status < 300
      }
    } catch {
      this.helper?.kill()
      this.helper = null
    }
  }

  stop(): void {
    this.helper?.kill()
    this.helper = null
    this.registered = false
  }

  async dispose(): Promise<void> {
    this.stop()
  }
}
