import type { OpenCodeServer } from './opencode-server'

/**
 * OpenCode's global stream wraps project-scoped events so one connection can
 * observe every directory handled by the server. Keep the EventStream public
 * contract identical to the legacy `/event` stream by passing only the native
 * event payload to the backend adapter.
 */
export function unwrapOpenCodeEvent(data: string): string {
  try {
    const event = JSON.parse(data) as { payload?: unknown }
    if (event && typeof event === 'object' && event.payload && typeof event.payload === 'object') {
      return JSON.stringify(event.payload)
    }
  } catch {
    /* Let the backend adapter report malformed events as unknown. */
  }
  return data
}

export class EventStream {
  private readonly server: OpenCodeServer
  private active = false
  private controller: AbortController | null = null
  private retryTimer: NodeJS.Timeout | null = null

  onEvent?: (data: string) => void
  onConnected?: () => void
  onDisconnected?: () => void

  constructor(server: OpenCodeServer) {
    this.server = server
  }

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
        let res = await fetch(`${this.server.baseUrl}/global/event`, {
          headers: { Authorization: this.server.authHeader },
          signal: controller.signal
        })
        // Older OpenCode builds predate the global stream. They can still run
        // against the original directory-scoped endpoint.
        if (res.status === 404 || res.status === 405) {
          await res.body?.cancel()
          res = await fetch(`${this.server.baseUrl}/event`, {
            headers: { Authorization: this.server.authHeader },
            signal: controller.signal
          })
        }
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
              if (payload) this.onEvent?.(unwrapOpenCodeEvent(payload))
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
