import { spawn, type ChildProcess } from 'node:child_process'

/**
 * Minimal MCP client for the hub: initialize, tools/list, tools/call.
 * Two transports — stdio (newline-delimited JSON-RPC) and Streamable HTTP
 * (JSON-RPC over POST; responses arrive as application/json or as a
 * text/event-stream carrying JSON-RPC messages).
 */

const PROTOCOL_VERSION = '2025-06-18'
const REQUEST_TIMEOUT_MS = 60_000

export interface McpToolDefinition {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface McpCallResult {
  content: Array<Record<string, unknown>>
  isError?: boolean
}

interface JsonRpcResponse {
  jsonrpc?: string
  id?: number | string | null
  result?: unknown
  error?: { code?: number; message?: string }
}

export interface McpClient {
  /** Resolves to the server's usage instructions, when it provides any. */
  initialize(): Promise<string | undefined>
  listTools(): Promise<McpToolDefinition[]>
  callTool(name: string, args: unknown): Promise<McpCallResult>
  close(): Promise<void>
}

function instructionsFromResult(result: unknown): string | undefined {
  const instructions = (result as { instructions?: unknown })?.instructions
  return typeof instructions === 'string' && instructions.trim() ? instructions.trim() : undefined
}

function rpcError(response: JsonRpcResponse): Error | null {
  if (!response.error) return null
  return new Error(response.error.message || `MCP error ${response.error.code ?? ''}`.trim())
}

function toolsFromResult(result: unknown): McpToolDefinition[] {
  const tools = (result as { tools?: unknown })?.tools
  if (!Array.isArray(tools)) return []
  return tools
    .filter((tool): tool is Record<string, unknown> => Boolean(tool) && typeof tool === 'object')
    .map((tool) => ({
      name: String(tool.name ?? ''),
      description: typeof tool.description === 'string' ? tool.description : undefined,
      inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object'
        ? tool.inputSchema as Record<string, unknown>
        : undefined
    }))
    .filter((tool) => tool.name)
}

function callResult(result: unknown): McpCallResult {
  const value = (result ?? {}) as { content?: unknown; isError?: unknown }
  return {
    content: Array.isArray(value.content) ? value.content as Array<Record<string, unknown>> : [],
    isError: value.isError === true
  }
}

export class StdioMcpClient implements McpClient {
  private child?: ChildProcess
  private nextId = 1
  private buffer = ''
  private readonly pending = new Map<number, { resolve: (value: JsonRpcResponse) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  private closed = false

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly env: Record<string, string>
  ) {}

  private fail(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }

  private start(): ChildProcess {
    if (this.child) return this.child
    const child = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.env }
    })
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      this.buffer += chunk
      let index = this.buffer.indexOf('\n')
      while (index >= 0) {
        const line = this.buffer.slice(0, index).trim()
        this.buffer = this.buffer.slice(index + 1)
        if (line) this.dispatch(line)
        index = this.buffer.indexOf('\n')
      }
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', () => { /* MCP servers may log freely to stderr. */ })
    child.on('error', (error) => this.fail(error))
    child.on('exit', (code) => {
      this.child = undefined
      if (!this.closed) this.fail(new Error(`The MCP server process exited${code === null ? '' : ` with code ${code}`}.`))
    })
    this.child = child
    return child
  }

  private dispatch(line: string): void {
    let message: JsonRpcResponse
    try {
      message = JSON.parse(line) as JsonRpcResponse
    } catch {
      return
    }
    if (typeof message.id !== 'number') return
    const entry = this.pending.get(message.id)
    if (!entry) return
    this.pending.delete(message.id)
    clearTimeout(entry.timer)
    entry.resolve(message)
  }

  private write(payload: Record<string, unknown>): void {
    const child = this.start()
    if (!child.stdin?.writable) throw new Error('The MCP server process is not accepting input.')
    child.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  private request(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
    const id = this.nextId++
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`The MCP server did not answer ${method} within ${REQUEST_TIMEOUT_MS / 1000}s.`))
      }, REQUEST_TIMEOUT_MS)
      timer.unref()
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.write({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async initialize(): Promise<string | undefined> {
    const response = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'ralf-mcp-hub', version: '1.0.0' }
    })
    const error = rpcError(response)
    if (error) throw error
    this.write({ jsonrpc: '2.0', method: 'notifications/initialized' })
    return instructionsFromResult(response.result)
  }

  async listTools(): Promise<McpToolDefinition[]> {
    const response = await this.request('tools/list', {})
    const error = rpcError(response)
    if (error) throw error
    return toolsFromResult(response.result)
  }

  async callTool(name: string, args: unknown): Promise<McpCallResult> {
    const response = await this.request('tools/call', { name, arguments: args ?? {} })
    const error = rpcError(response)
    if (error) throw error
    return callResult(response.result)
  }

  async close(): Promise<void> {
    this.closed = true
    const child = this.child
    this.child = undefined
    this.fail(new Error('The MCP connection is closing.'))
    if (!child || child.pid === undefined || child.exitCode !== null) return
    child.kill()
    await new Promise<void>((resolveExit) => {
      const force = setTimeout(() => {
        child.kill('SIGKILL')
        resolveExit()
      }, 2_000)
      force.unref()
      child.once('exit', () => {
        clearTimeout(force)
        resolveExit()
      })
    })
  }
}

export class HttpMcpClient implements McpClient {
  private nextId = 1
  private sessionId?: string

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>
  ) {}

  private async post(payload: Record<string, unknown>, expectReply: boolean): Promise<JsonRpcResponse | undefined> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    timer.unref()
    let response: Response
    try {
      response = await fetch(this.url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': PROTOCOL_VERSION,
          ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
          ...this.headers
        },
        body: JSON.stringify(payload)
      })
    } finally {
      clearTimeout(timer)
    }
    const session = response.headers.get('mcp-session-id')
    if (session) this.sessionId = session
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300)
      throw new Error(`The MCP server answered ${response.status}.${detail ? ` ${detail}` : ''}`)
    }
    if (!expectReply) return undefined
    const contentType = response.headers.get('content-type') ?? ''
    const body = await response.text()
    if (contentType.includes('text/event-stream')) {
      const id = payload.id
      for (const block of body.split('\n\n')) {
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('')
        if (!data) continue
        try {
          const message = JSON.parse(data) as JsonRpcResponse
          if (message.id === id) return message
        } catch {
          /* Skip non-JSON stream events. */
        }
      }
      throw new Error('The MCP server stream ended without a response.')
    }
    return JSON.parse(body) as JsonRpcResponse
  }

  private async request(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
    const payload = { jsonrpc: '2.0', id: this.nextId++, method, ...(params ? { params } : {}) }
    const response = await this.post(payload, true)
    if (!response) throw new Error('The MCP server sent no response.')
    return response
  }

  async initialize(): Promise<string | undefined> {
    const response = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'ralf-mcp-hub', version: '1.0.0' }
    })
    const error = rpcError(response)
    if (error) throw error
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, false).catch(() => {
      /* Some servers reject the notification; tools still work. */
    })
    return instructionsFromResult(response.result)
  }

  async listTools(): Promise<McpToolDefinition[]> {
    const response = await this.request('tools/list', {})
    const error = rpcError(response)
    if (error) throw error
    return toolsFromResult(response.result)
  }

  async callTool(name: string, args: unknown): Promise<McpCallResult> {
    const response = await this.request('tools/call', { name, arguments: args ?? {} })
    const error = rpcError(response)
    if (error) throw error
    return callResult(response.result)
  }

  async close(): Promise<void> {
    this.sessionId = undefined
  }
}
