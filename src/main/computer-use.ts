import type { ComputerUseStatus } from '@shared/ipc'
import type { ApiClient } from './api-client'

export class ComputerUse {
  private registered = false
  private enabled = false

  onStatusChange?: (status: ComputerUseStatus) => void

  constructor(
    private readonly api: ApiClient,
    private readonly helperPath: string
  ) {}

  get status(): ComputerUseStatus {
    return { enabled: this.enabled, running: this.registered }
  }

  async setEnabled(on: boolean): Promise<ComputerUseStatus> {
    if (on && !this.registered) {
      try {
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
      } catch {
        this.registered = false
      }
    }
    this.enabled = on
    this.onStatusChange?.(this.status)
    return this.status
  }

  async dispose(): Promise<void> {
    this.enabled = false
  }
}
