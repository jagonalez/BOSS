import type { OpenCodeServer } from './opencode-server'

export class EventStream {
  private active = false
  private controller: AbortController | null = null
  private retryTimer: NodeJS.Timeout | null = null

  onEvent?: (data: string) => void
  onConnected?: () => void
  onDisconnected?: () => void

  constructor(private readonly server: OpenCodeServer) {}

  start(): void {
    if (this.active) return
    this.active = true
    void this.run()
  }

  stop(): void {
    this.active = false
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.controller?.abort()
  }

  private async run(): Promise<void> {
    while (this.active) {
      const controller = new AbortController()
      this.controller = controller
      try {
        const res = await fetch(`${this.server.baseUrl}/event`, {
          headers: { Authorization: this.server.authHeader },
          signal: controller.signal
        })
        if (!res.ok) throw new Error(`event stream status ${res.status}`)
        if (!res.body) throw new Error('event stream has no body')
        this.onConnected?.()
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (this.active) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let idx: number
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, idx)
            buffer = buffer.slice(idx + 2)
            for (const line of block.split('\n')) {
              if (!line.startsWith('data:')) continue
              const payload = line.slice(5).trimStart()
              if (payload) this.onEvent?.(payload)
            }
          }
        }
      } catch {
        if (!this.active) return
      }
      this.onDisconnected?.()
      if (this.active) {
        await new Promise((r) => {
          this.retryTimer = setTimeout(r, 1000)
        })
      }
    }
  }
}
