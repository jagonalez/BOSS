import type { ApiRequest, ApiResponse } from '@shared/ipc'
import type { OpenCodeServer } from './opencode-server'

export class ApiClient {
  constructor(private readonly server: OpenCodeServer) {}

  async request(req: ApiRequest, attempt = 0): Promise<ApiResponse> {
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
          'Content-Type': 'application/json',
          ...(req.directory ? { 'x-opencode-directory': req.directory } : {})
        },
        body: req.body !== undefined ? JSON.stringify(req.body) : undefined
      })
    } catch (err) {
      const isNetwork = /fetch failed|ECONNREFUSED|ECONNRESET|socket hang/i.test(String(err))
      if (isNetwork && attempt < 5) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
        return this.request(req, attempt + 1)
      }
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
