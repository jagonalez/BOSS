import type { ApiRequest, ApiResponse } from '@shared/ipc'
import type { OpenCodeServer } from './opencode-server'

export class ApiClient {
  constructor(private readonly server: OpenCodeServer) {}

  async request(req: ApiRequest): Promise<ApiResponse> {
    const url = new URL(`${this.server.baseUrl}${req.path}`)
    if (req.query) {
      for (const [key, value] of Object.entries(req.query)) {
        if (value !== undefined) url.searchParams.set(key, String(value))
      }
    }
    let res: Response
    try {
      res = await fetch(url, {
        method: req.method,
        headers: {
          Authorization: this.server.authHeader,
          'Content-Type': 'application/json'
        },
        body: req.body !== undefined ? JSON.stringify(req.body) : undefined
      })
    } catch (err) {
      return { status: 0, body: { error: String(err) } }
    }
    const text = await res.text()
    let body: unknown = text
    if (text) {
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
    }
    return { status: res.status, body }
  }
}
