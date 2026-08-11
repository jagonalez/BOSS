import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Backend, McpServerConfig, ModelInfo, ThinkingLevel } from './backend'
import type { BackendMessageOptions } from '@shared/backend'
import type { ThreadBusConnection } from '@shared/thread-bus'
import type { EventMessage, SessionInfo, MessageWithParts, Todo, FileDiff, FileNode, FileContent, Part } from '@shared/opencode'
import { textFromParts } from './manager'

interface ClaudeStore {
  version: 1
  sessions: Record<string, { title?: string; projectPath: string; createdAt: number; updatedAt: number; messages: MessageWithParts[] }>
}

function storeFile(): string {
  return join(app.getPath('userData'), 'claude-threads.json')
}

function contentParts(sessionId: string, messageId: string, content: unknown): Part[] {
  if (!Array.isArray(content)) return []
  return content.flatMap<Part>((block, index): Part[] => {
    if (!block || typeof block !== 'object') return []
    const item = block as Record<string, unknown>
    if (item.type === 'text' || item.type === 'thinking') {
      return [{
        id: `${messageId}-${String(item.type)}-${index}`,
        type: item.type === 'thinking' ? 'reasoning' as const : 'text' as const,
        sessionID: sessionId,
        messageID: messageId,
        text: String(item.text ?? item.thinking ?? '')
      }]
    }
    if (item.type === 'tool_use') {
      return [{
        id: String(item.id ?? `${messageId}-tool-${index}`),
        type: 'tool' as const,
        sessionID: sessionId,
        messageID: messageId,
        state: { status: 'running' as const, tool: String(item.name ?? 'tool'), input: item.input }
      }]
    }
    if (item.type === 'tool_result') {
      return [{
        id: String(item.tool_use_id ?? `${messageId}-result-${index}`),
        type: 'tool' as const,
        sessionID: sessionId,
        messageID: messageId,
        state: { status: item.is_error ? 'error' as const : 'completed' as const, output: item.content }
      }]
    }
    return []
  })
}

export class ClaudeBackend implements Backend {
  readonly id = 'claude' as const
  private eventCb?: (event: EventMessage) => void
  private projectPath = ''
  private version = ''
  private healthy = false
  private processes = new Map<string, ChildProcess>()
  private store: ClaudeStore = { version: 1, sessions: {} }
  private threadBus?: ThreadBusConnection

  constructor(cwd?: string) {
    this.projectPath = cwd ?? ''
  }

  async start(): Promise<void> {
    try {
      this.version = execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 2500 }).trim()
    } catch {
      throw new Error('Claude Code is not installed or could not be started.')
    }
    try {
      const parsed = JSON.parse(readFileSync(storeFile(), 'utf8')) as ClaudeStore
      if (parsed.version === 1 && parsed.sessions) this.store = parsed
    } catch {
      /* First launch. */
    }
    this.healthy = true
  }

  async stop(): Promise<void> {
    for (const process of this.processes.values()) process.kill()
    this.processes.clear()
    this.healthy = false
  }

  async setProject(path: string): Promise<void> {
    this.projectPath = path
  }

  info() {
    return { id: this.id, engine: 'claude-code', version: this.version, healthy: this.healthy, projectPath: this.projectPath }
  }

  supportsMcp(): boolean { return false }
  async registerMcpServer(_name: string, _config: McpServerConfig): Promise<boolean> { return false }
  async unregisterMcpServer(_name: string): Promise<void> {}
  configureThreadBus(connection: ThreadBusConnection): void { this.threadBus = connection }
  onEvent(callback: (event: EventMessage) => void): () => void {
    this.eventCb = callback
    return () => { if (this.eventCb === callback) this.eventCb = undefined }
  }

  private emit(event: EventMessage): void { this.eventCb?.(event) }
  private save(): void {
    try { writeFileSync(storeFile(), JSON.stringify(this.store, null, 2)) } catch { /* keep in memory */ }
  }

  private record(sessionId: string) {
    const record = this.store.sessions[sessionId]
    if (!record) throw new Error(`Claude thread not found: ${sessionId}`)
    return record
  }

  async sessionsList(): Promise<SessionInfo[]> {
    return Object.entries(this.store.sessions)
      .filter(([, record]) => !this.projectPath || record.projectPath === this.projectPath)
      .map(([id, record]) => ({
        id,
        title: record.title,
        directory: record.projectPath,
        time: { created: record.createdAt, updated: record.updatedAt }
      }))
  }

  async sessionCreate(title?: string): Promise<SessionInfo> {
    const id = randomUUID()
    const time = Date.now()
    this.store.sessions[id] = { title, projectPath: this.projectPath, createdAt: time, updatedAt: time, messages: [] }
    this.save()
    return { id, title, directory: this.projectPath, time: { created: time, updated: time } }
  }

  async sessionDelete(id: string): Promise<void> {
    this.processes.get(id)?.kill()
    this.processes.delete(id)
    delete this.store.sessions[id]
    this.save()
  }

  async sessionRename(id: string, title: string): Promise<SessionInfo> {
    const record = this.record(id)
    record.title = title
    record.updatedAt = Date.now()
    this.save()
    return { id, title, directory: record.projectPath, time: { updated: record.updatedAt } }
  }

  async sessionGet(id: string): Promise<SessionInfo> {
    const record = this.record(id)
    return { id, title: record.title, directory: record.projectPath, time: { created: record.createdAt, updated: record.updatedAt } }
  }

  async messagesList(sessionId: string, limit?: number): Promise<MessageWithParts[]> {
    const messages = this.record(sessionId).messages
    return limit ? messages.slice(-limit) : messages
  }

  private upsert(sessionId: string, message: MessageWithParts): void {
    const record = this.record(sessionId)
    const index = record.messages.findIndex((item) => item.info.id === message.info.id)
    if (index >= 0) record.messages[index] = message
    else record.messages.push(message)
    record.updatedAt = Date.now()
    this.save()
    this.emit({ type: 'message.updated', message: message.info })
    message.parts.forEach((part) => this.emit({ type: 'message.part.updated', part }))
  }

  private applyToolResults(sessionId: string, content: unknown): void {
    if (!Array.isArray(content)) return
    const record = this.record(sessionId)
    let changed = false
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const result = block as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }
      if (result.type !== 'tool_result' || !result.tool_use_id) continue
      for (const message of record.messages) {
        const index = message.parts.findIndex((part) => part.id === result.tool_use_id)
        if (index < 0) continue
        const part = message.parts[index]
        const next: Part = {
          ...part,
          state: {
            ...part.state,
            status: result.is_error ? 'error' : 'completed',
            output: result.content
          }
        }
        message.parts[index] = next
        this.emit({ type: 'message.part.updated', part: next })
        changed = true
      }
    }
    if (changed) {
      record.updatedAt = Date.now()
      this.save()
    }
  }

  async sendMessage(sessionId: string, parts: unknown[], options?: BackendMessageOptions): Promise<void> {
    if (this.processes.has(sessionId)) throw new Error('Claude Code is already working on this thread.')
    const record = this.record(sessionId)
    const prompt = textFromParts(parts)
    const userId = randomUUID()
    this.upsert(sessionId, {
      info: { id: userId, sessionID: sessionId, role: 'user', time: { created: Date.now() } },
      parts: [{ id: `${userId}-text`, type: 'text', sessionID: sessionId, messageID: userId, text: prompt }]
    })

    const hasHistory = record.messages.some((message) => message.info.role === 'assistant')
    const mode = options?.mode === 'plan'
      ? 'plan'
      : options?.mode === 'auto'
        ? 'auto'
        : options?.mode === 'accept-edits'
          ? 'acceptEdits'
          : 'default'
    const threadBusConfig = this.threadBus ? JSON.stringify({
      mcpServers: {
        ralf_thread_bus: {
          type: 'http',
          url: `${this.threadBus.url}/mcp`,
          headers: {
            Authorization: 'Bearer ${RALF_THREAD_BUS_TOKEN}',
            'X-Ralf-Backend': 'claude',
            'X-Ralf-Thread': '${RALF_NATIVE_THREAD_ID}'
          }
        }
      }
    }) : ''
    const allowedThreadTools = [
      'mcp__ralf_thread_bus__ralf_threads_list',
      'mcp__ralf_thread_bus__ralf_threads_read',
      'mcp__ralf_thread_bus__ralf_threads_send',
      'mcp__ralf_thread_bus__ralf_threads_reply'
    ].join(',')
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode', mode,
      ...(threadBusConfig ? ['--mcp-config', threadBusConfig, '--allowedTools', allowedThreadTools] : []),
      ...(hasHistory ? ['--resume', sessionId] : ['--session-id', sessionId]),
      ...(options?.model?.modelID ? ['--model', options.model.modelID] : []),
      ...(options?.model?.variant ? ['--effort', options.model.variant] : []),
      prompt
    ]
    const child = spawn('claude', args, {
      cwd: record.projectPath || this.projectPath || globalThis.process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...(this.threadBus ? {
          RALF_THREAD_BUS_TOKEN: this.threadBus.tokenFor('claude', sessionId),
          RALF_NATIVE_THREAD_ID: sessionId
        } : {})
      }
    })
    this.processes.set(sessionId, child)
    this.emit({ type: 'session.status', sessionID: sessionId, status: { type: 'busy' } })

    let buffer = ''
    let assistantId: string = randomUUID()
    let liveText = ''
    const decoder = new TextDecoder()
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += decoder.decode(chunk, { stream: true })
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '')
        buffer = buffer.slice(index + 1)
        if (line.trim()) {
          try {
            const value = JSON.parse(line) as Record<string, unknown>
            if (value.type === 'system' && value.subtype === 'init' && Array.isArray(value.mcp_server_errors) && value.mcp_server_errors.length > 0) {
              this.emit({
                type: 'session.error',
                sessionID: sessionId,
                error: `Claude Code could not load R.A.L.F. thread tools: ${value.mcp_server_errors.map(String).join('; ')}`
              })
            } else if (value.type === 'assistant') {
              const message = value.message as { id?: string; content?: unknown; model?: string } | undefined
              assistantId = message?.id ?? assistantId
              this.upsert(sessionId, {
                info: { id: assistantId, sessionID: sessionId, role: 'assistant', model: message?.model ? { id: message.model, provider: 'anthropic' } : undefined, time: { created: Date.now() } },
                parts: contentParts(sessionId, assistantId, message?.content)
              })
            } else if (value.type === 'user') {
              const message = value.message as { content?: unknown } | undefined
              this.applyToolResults(sessionId, message?.content)
            } else if (value.type === 'stream_event') {
              const event = value.event as Record<string, unknown> | undefined
              const delta = event?.delta as Record<string, unknown> | undefined
              if (event?.type === 'message_start') {
                const message = event.message as { id?: string } | undefined
                assistantId = message?.id ?? assistantId
                liveText = ''
              } else if (event?.type === 'content_block_delta' && delta?.type === 'text_delta') {
                liveText += String(delta.text ?? '')
                this.upsert(sessionId, {
                  info: { id: assistantId, sessionID: sessionId, role: 'assistant', time: { created: Date.now() } },
                  parts: [{ id: `${assistantId}-text`, type: 'text', sessionID: sessionId, messageID: assistantId, text: liveText }]
                })
              }
            } else if (value.type === 'result' && value.subtype !== 'success') {
              this.emit({ type: 'session.error', sessionID: sessionId, error: String(value.error ?? value.result ?? 'Claude Code failed.') })
            }
          } catch {
            /* Ignore non-protocol diagnostic output. */
          }
        }
        index = buffer.indexOf('\n')
      }
    })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', (error) => this.emit({ type: 'session.error', sessionID: sessionId, error: error.message }))
    child.on('exit', (code) => {
      this.processes.delete(sessionId)
      if (code && code !== 0) this.emit({ type: 'session.error', sessionID: sessionId, error: stderr.trim() || `Claude Code exited with ${code}.` })
      this.emit({ type: 'session.status', sessionID: sessionId, status: { type: 'idle' } })
      this.emit({ type: 'session.idle', sessionID: sessionId })
    })
  }

  async abort(sessionId: string): Promise<void> {
    this.processes.get(sessionId)?.kill('SIGINT')
  }

  async modelsList(): Promise<ModelInfo[]> {
    return [
      { id: 'sonnet', name: 'Sonnet', provider: 'anthropic', variants: ['low', 'medium', 'high'] },
      { id: 'opus', name: 'Opus', provider: 'anthropic', variants: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { id: 'fable', name: 'Fable', provider: 'anthropic' },
      { id: 'haiku', name: 'Haiku', provider: 'anthropic' }
    ]
  }

  async modelSelect(_providerId: string, _modelId: string): Promise<void> {}
  async thinkingGet(): Promise<ThinkingLevel> { return { level: 'medium' } }
  async thinkingSet(_level: ThinkingLevel['level']): Promise<void> {}
  async todosGet(_sessionId: string): Promise<Todo[]> { return [] }
  async permissionRespond(_sessionId: string, _permissionId: string, _response: 'once' | 'always' | 'reject'): Promise<void> {}
  async diffGet(_sessionId: string, _messageId?: string): Promise<FileDiff[]> { return [] }
  async fileTree(_path?: string): Promise<FileNode[]> { return [] }
  async fileContent(path: string): Promise<FileContent> { return { path, content: '' } }
  async fork(sessionId: string): Promise<SessionInfo> { return { id: sessionId } }
  async revert(_sessionId: string, _messageId: string): Promise<void> {}
  async unrevert(_sessionId: string): Promise<void> {}
  async compact(_sessionId: string): Promise<void> {}
}
