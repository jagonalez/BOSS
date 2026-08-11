import { randomUUID } from 'node:crypto'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { unlinkSync } from 'node:fs'
import type { Backend, McpServerConfig, ThinkingLevel } from './backend'
import type { BackendMessageOptions } from '@shared/backend'
import type { EventMessage, SessionInfo, MessageWithParts, Todo, FileDiff, FileNode, FileContent, Part } from '@shared/opencode'

type RpcRequest = { id?: string; type: string; [key: string]: unknown }
type RpcResponse = { id?: string; type: 'response'; command: string; success: boolean; data?: unknown; error?: string }
type Pending = { resolve: (value: RpcResponse) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }

interface PiState {
  sessionId: string
  sessionFile?: string
  sessionName?: string
  isStreaming?: boolean
  model?: { id?: string; name?: string; provider?: string }
  thinkingLevel?: ThinkingLevel['level']
}

interface PiMessage {
  id?: string
  role?: 'user' | 'assistant' | 'toolResult' | 'bashExecution'
  content?: string | Array<Record<string, unknown>>
  timestamp?: number | string
  model?: string
  provider?: string
  toolCallId?: string
  toolName?: string
  isError?: boolean
}

function promptContent(parts: unknown[]): { message: string; images: Array<{ type: 'image'; data: string; mimeType: string }> } {
  const text: string[] = []
  const images: Array<{ type: 'image'; data: string; mimeType: string }> = []
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue
    const item = part as { type?: string; text?: string; filename?: string; mime?: string; url?: string }
    if (item.type === 'text' && item.text) {
      text.push(item.text)
      continue
    }
    if (item.type === 'file' && item.mime?.startsWith('image/') && item.url) {
      const match = /^data:([^;,]+);base64,(.*)$/s.exec(item.url)
      if (match) {
        images.push({ type: 'image', mimeType: match[1] || item.mime, data: match[2] })
        continue
      }
    }
    if (item.type === 'file') text.push(`[Attached file: ${item.filename ?? item.mime ?? 'file'}]`)
  }
  return { message: text.join('\n'), images }
}

function contentParts(sessionId: string, messageId: string, content: PiMessage['content']): Part[] {
  if (typeof content === 'string') {
    return [{ id: `${messageId}-text`, type: 'text', sessionID: sessionId, messageID: messageId, text: content }]
  }
  if (!Array.isArray(content)) return []
  return content.flatMap<Part>((block, index): Part[] => {
    const type = String(block.type ?? '')
    if (type === 'text' || type === 'thinking') {
      return [{
        id: `${messageId}-${type}-${index}`,
        type: type === 'thinking' ? 'reasoning' as const : 'text' as const,
        sessionID: sessionId,
        messageID: messageId,
        text: String(block.text ?? block.thinking ?? '')
      }]
    }
    if (type === 'toolCall' || type === 'tool_use') {
      return [{
        id: String(block.id ?? `${messageId}-tool-${index}`),
        type: 'tool' as const,
        sessionID: sessionId,
        messageID: messageId,
        state: {
          status: 'running' as const,
          tool: String(block.name ?? 'tool'),
          input: block.arguments ?? block.input
        }
      }]
    }
    return []
  })
}

function toMessage(sessionId: string, value: PiMessage, index: number): MessageWithParts | null {
  if (value.role !== 'user' && value.role !== 'assistant') return null
  const created = typeof value.timestamp === 'number' ? value.timestamp : Date.parse(String(value.timestamp ?? '')) || Date.now()
  const id = value.id ?? `${sessionId}-${created}-${index}`
  return {
    info: {
      id,
      sessionID: sessionId,
      role: value.role,
      model: value.model ? { id: value.model, provider: value.provider } : undefined,
      time: { created }
    },
    parts: contentParts(sessionId, id, value.content)
  }
}

class PiRpcSession {
  private process: ChildProcess | null = null
  private nextId = 1
  private pending = new Map<string, Pending>()
  private buffer = ''

  constructor(
    public sessionId: string,
    private readonly cwd: string,
    private readonly onEvent: (sessionId: string, event: Record<string, unknown>) => void
  ) {}

  async start(): Promise<void> {
    if (this.process) return
    this.process = spawn('pi', ['--mode', 'rpc', '--session-id', this.sessionId, '--approve'], {
      cwd: this.cwd || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const decoder = new TextDecoder()
    this.process.stdout?.on('data', (chunk: Buffer) => {
      this.buffer += decoder.decode(chunk, { stream: true })
      let index = this.buffer.indexOf('\n')
      while (index >= 0) {
        const line = this.buffer.slice(0, index).replace(/\r$/, '')
        this.buffer = this.buffer.slice(index + 1)
        this.handleLine(line)
        index = this.buffer.indexOf('\n')
      }
    })
    this.process.stderr?.on('data', () => {})
    this.process.on('error', (error) => this.rejectAll(error))
    this.process.on('exit', () => {
      this.process = null
      this.rejectAll(new Error('Pi RPC process exited.'))
      this.onEvent(this.sessionId, { type: 'server.disconnected' })
    })
    await this.send({ type: 'get_state' })
  }

  stop(): void {
    this.process?.kill()
    this.process = null
    this.rejectAll(new Error('Pi RPC process stopped.'))
  }

  send(request: RpcRequest, timeoutMs = 30_000): Promise<RpcResponse> {
    if (!this.process?.stdin) return Promise.reject(new Error('Pi RPC process is not running.'))
    const id = String(this.nextId++)
    this.process.stdin.write(`${JSON.stringify({ ...request, id })}\n`)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Pi ${request.type} request timed out.`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
    })
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private handleLine(line: string): void {
    if (!line.trim()) return
    let value: Record<string, unknown>
    try {
      value = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    if (value.type === 'response') {
      const response = value as RpcResponse
      const pending = this.pending.get(response.id ?? '')
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(response.id ?? '')
      if (response.success) pending.resolve(response)
      else pending.reject(new Error(response.error ?? `Pi ${response.command} failed.`))
      return
    }
    this.onEvent(this.sessionId, value)
  }
}

export class PiBackend implements Backend {
  readonly id = 'pi' as const
  private projectPath = ''
  private eventCb?: (event: EventMessage) => void
  private sessions = new Map<string, PiRpcSession>()
  private messageIds = new Map<string, string>()
  private liveText = new Map<string, string>()
  private version = ''
  private healthy = false

  constructor(cwd?: string) {
    this.projectPath = cwd ?? ''
  }

  async start(): Promise<void> {
    try {
      this.version = execFileSync('pi', ['--version'], { encoding: 'utf8', timeout: 2500 }).trim()
      this.healthy = true
    } catch {
      this.healthy = false
      throw new Error('Pi is not installed or could not be started.')
    }
  }

  async stop(): Promise<void> {
    for (const session of this.sessions.values()) session.stop()
    this.sessions.clear()
    this.healthy = false
  }

  async setProject(path: string): Promise<void> {
    if (path === this.projectPath) return
    for (const session of this.sessions.values()) session.stop()
    this.sessions.clear()
    this.projectPath = path
  }

  info() {
    return { id: this.id, engine: 'pi', version: this.version, healthy: this.healthy, projectPath: this.projectPath }
  }

  supportsMcp(): boolean { return false }
  async registerMcpServer(_name: string, _config: McpServerConfig): Promise<boolean> { return false }
  async unregisterMcpServer(_name: string): Promise<void> {}

  onEvent(callback: (event: EventMessage) => void): () => void {
    this.eventCb = callback
    return () => { if (this.eventCb === callback) this.eventCb = undefined }
  }

  private emit(event: EventMessage): void {
    this.eventCb?.(event)
  }

  private async runtime(sessionId: string): Promise<PiRpcSession> {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing
    const runtime = new PiRpcSession(sessionId, this.projectPath, (activeSessionId, event) => this.mapEvent(activeSessionId, event))
    this.sessions.set(sessionId, runtime)
    try {
      await runtime.start()
      return runtime
    } catch (error) {
      this.sessions.delete(sessionId)
      throw error
    }
  }

  private mapEvent(sessionId: string, event: Record<string, unknown>): void {
    switch (event.type) {
      case 'agent_start':
        this.emit({ type: 'session.status', sessionID: sessionId, status: { type: 'busy' } })
        break
      case 'agent_settled':
        this.emit({ type: 'session.status', sessionID: sessionId, status: { type: 'idle' } })
        this.emit({ type: 'session.idle', sessionID: sessionId })
        break
      case 'message_start': {
        const message = event.message as PiMessage | undefined
        if (!message || message.role !== 'assistant') break
        const id = message.id ?? randomUUID()
        this.messageIds.set(sessionId, id)
        this.liveText.set(sessionId, '')
        this.emit({ type: 'message.updated', message: { id, sessionID: sessionId, role: 'assistant', time: { created: Date.now() } } })
        break
      }
      case 'message_update': {
        const delta = event.assistantMessageEvent as { type?: string; delta?: string; content?: string } | undefined
        if (!delta || delta.type !== 'text_delta') break
        const messageID = this.messageIds.get(sessionId) ?? randomUUID()
        const text = `${this.liveText.get(sessionId) ?? ''}${delta.delta ?? ''}`
        this.messageIds.set(sessionId, messageID)
        this.liveText.set(sessionId, text)
        this.emit({
          type: 'message.part.updated',
          part: { id: `${messageID}-text`, type: 'text', sessionID: sessionId, messageID, text }
        })
        break
      }
      case 'message_end': {
        const message = event.message as PiMessage | undefined
        if (!message) break
        const converted = toMessage(
          sessionId,
          message.role === 'assistant' ? { ...message, id: message.id ?? this.messageIds.get(sessionId) } : message,
          0
        )
        if (!converted) break
        this.emit({ type: 'message.updated', message: converted.info })
        converted.parts.forEach((part) => this.emit({ type: 'message.part.updated', part }))
        break
      }
      case 'tool_execution_start': {
        const messageID = this.messageIds.get(sessionId) ?? randomUUID()
        this.emit({
          type: 'message.part.updated',
          part: {
            id: String(event.toolCallId ?? randomUUID()),
            type: 'tool',
            sessionID: sessionId,
            messageID,
            state: { status: 'running', tool: String(event.toolName ?? 'tool'), input: event.args }
          }
        })
        break
      }
      case 'tool_execution_end': {
        const messageID = this.messageIds.get(sessionId) ?? randomUUID()
        this.emit({
          type: 'message.part.updated',
          part: {
            id: String(event.toolCallId ?? randomUUID()),
            type: 'tool',
            sessionID: sessionId,
            messageID,
            state: {
              status: event.isError ? 'error' : 'completed',
              tool: String(event.toolName ?? 'tool'),
              output: event.result
            }
          }
        })
        break
      }
      case 'tool_execution_update': {
        const messageID = this.messageIds.get(sessionId) ?? randomUUID()
        this.emit({
          type: 'message.part.updated',
          part: {
            id: String(event.toolCallId ?? randomUUID()),
            type: 'tool',
            sessionID: sessionId,
            messageID,
            state: {
              status: 'running',
              tool: String(event.toolName ?? 'tool'),
              input: event.args,
              output: event.partialResult
            }
          }
        })
        break
      }
      case 'compaction_start':
        this.emit({ type: 'session.status', sessionID: sessionId, status: { type: 'busy' } })
        break
      case 'compaction_end':
        this.emit({ type: 'session.compacted', sessionID: sessionId })
        break
      case 'extension_error':
        this.emit({ type: 'session.error', sessionID: sessionId, error: String(event.error ?? 'Pi extension error') })
        break
    }
  }

  async sessionsList(): Promise<SessionInfo[]> {
    return Promise.all([...this.sessions.keys()].map((id) => this.sessionGet(id)))
  }

  async sessionCreate(title?: string): Promise<SessionInfo> {
    const id = randomUUID()
    const runtime = await this.runtime(id)
    if (title) await runtime.send({ type: 'set_session_name', name: title })
    return { id, title, directory: this.projectPath, time: { created: Date.now(), updated: Date.now() } }
  }

  async sessionDelete(id: string): Promise<void> {
    const runtime = await this.runtime(id)
    const state = (await runtime.send({ type: 'get_state' })).data as PiState | undefined
    runtime.stop()
    this.sessions.delete(id)
    if (state?.sessionFile) {
      try { unlinkSync(state.sessionFile) } catch { /* already gone or managed externally */ }
    }
  }

  async sessionRename(id: string, title: string): Promise<SessionInfo> {
    await (await this.runtime(id)).send({ type: 'set_session_name', name: title })
    return { id, title, directory: this.projectPath, time: { updated: Date.now() } }
  }

  async sessionGet(id: string): Promise<SessionInfo> {
    const state = (await (await this.runtime(id)).send({ type: 'get_state' })).data as PiState | undefined
    return {
      id,
      title: state?.sessionName,
      directory: this.projectPath,
      path: state?.sessionFile,
      model: state?.model?.id ? { id: state.model.id, provider: state.model.provider } : undefined,
      time: { updated: Date.now() }
    }
  }

  async messagesList(sessionId: string, limit?: number): Promise<MessageWithParts[]> {
    const response = await (await this.runtime(sessionId)).send({ type: 'get_messages' })
    const data = response.data as { messages?: PiMessage[] } | undefined
    const messages: MessageWithParts[] = []
    for (const [index, message] of (data?.messages ?? []).entries()) {
      if (message.role === 'toolResult' && message.toolCallId) {
        for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
          const partIndex = messages[messageIndex].parts.findIndex((part) => part.id === message.toolCallId)
          if (partIndex < 0) continue
          const part = messages[messageIndex].parts[partIndex]
          messages[messageIndex].parts[partIndex] = {
            ...part,
            state: {
              ...part.state,
              status: message.isError ? 'error' : 'completed',
              tool: message.toolName ?? part.state?.tool,
              output: message.content
            }
          }
          break
        }
        continue
      }
      const converted = toMessage(sessionId, message, index)
      if (converted) messages.push(converted)
    }
    return limit ? messages.slice(-limit) : messages
  }

  async sendMessage(sessionId: string, parts: unknown[], options?: BackendMessageOptions): Promise<void> {
    const runtime = await this.runtime(sessionId)
    if (options?.model) {
      await runtime.send({ type: 'set_model', provider: options.model.providerID, modelId: options.model.modelID })
      if (options.model.variant) await runtime.send({ type: 'set_thinking_level', level: options.model.variant })
    }
    const content = promptContent(parts)
    await runtime.send({ type: 'prompt', message: content.message, ...(content.images.length ? { images: content.images } : {}) })
  }

  async abort(sessionId: string): Promise<void> { await (await this.runtime(sessionId)).send({ type: 'abort' }) }

  async modelsList(): Promise<{ id: string; name?: string; provider?: string; variants?: string[] }[]> {
    const runtime = this.sessions.values().next().value as PiRpcSession | undefined
    if (!runtime) return []
    const response = await runtime.send({ type: 'get_available_models' })
    const data = response.data as {
      models?: Array<{ id: string; name?: string; provider?: string; reasoning?: boolean; thinkingLevelMap?: Record<string, unknown> }>
    } | Array<{ id: string; name?: string; provider?: string; reasoning?: boolean; thinkingLevelMap?: Record<string, unknown> }> | undefined
    const models = Array.isArray(data) ? data : data?.models ?? []
    return models.map((model) => {
      const explicit = Object.keys(model.thinkingLevelMap ?? {})
      return {
        id: model.id,
        name: model.name,
        provider: model.provider,
        variants: explicit.length > 0 ? explicit : model.reasoning ? ['off', 'minimal', 'low', 'medium', 'high'] : []
      }
    })
  }

  async modelSelect(_providerId: string, _modelId: string): Promise<void> {}
  async thinkingGet(): Promise<ThinkingLevel> { return { level: 'medium' } }
  async thinkingSet(_level: ThinkingLevel['level']): Promise<void> {}
  async todosGet(_sessionId: string): Promise<Todo[]> { return [] }
  async permissionRespond(_sessionId: string, _permissionId: string, _response: 'once' | 'always' | 'reject'): Promise<void> {}
  async diffGet(_sessionId: string, _messageId?: string): Promise<FileDiff[]> { return [] }
  async fileTree(_path?: string): Promise<FileNode[]> { return [] }
  async fileContent(path: string): Promise<FileContent> { return { path, content: '' } }

  async fork(sessionId: string, _messageId?: string): Promise<SessionInfo> {
    const runtime = await this.runtime(sessionId)
    await runtime.send({ type: 'clone' })
    const state = (await runtime.send({ type: 'get_state' })).data as PiState | undefined
    const newId = state?.sessionId
    if (!newId || newId === sessionId) return { id: sessionId }
    this.sessions.delete(sessionId)
    runtime.sessionId = newId
    this.sessions.set(newId, runtime)
    return { id: newId, title: state.sessionName, directory: this.projectPath, path: state.sessionFile }
  }

  async revert(_sessionId: string, _messageId: string): Promise<void> {}
  async unrevert(_sessionId: string): Promise<void> {}
  async compact(sessionId: string): Promise<void> { await (await this.runtime(sessionId)).send({ type: 'compact' }, 120_000) }
}
