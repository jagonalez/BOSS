import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Backend, McpServerConfig, ModelInfo, ThinkingLevel } from './backend'
import type { BackendMessageOptions } from '@shared/backend'
import type { ThreadBusConnection } from '@shared/thread-bus'
import { QA_GUIDANCE, QA_TOOL_DEFINITIONS } from '@shared/qa'
import type { EventMessage, SessionInfo, MessageWithParts, Todo, FileDiff, FileNode, FileContent, Part } from '@shared/opencode'
import { textFromParts } from './manager'
import { claudePermissionMode, claudePermissionResponse, parseClaudePermission } from './claude-protocol'
import type { ClaudePermissionRequest } from './claude-protocol'

interface ClaudeProcess {
  child: ChildProcess
  permissions: Map<string, ClaudePermissionRequest>
}

function writeControl(child: ChildProcess, value: Record<string, unknown>): void {
  if (!child.stdin?.writable) throw new Error('Claude Code permission channel is no longer available.')
  child.stdin.write(`${JSON.stringify(value)}\n`)
}

interface ClaudeStore {
  version: 1
  sessions: Record<string, { title?: string; projectPath: string; createdAt: number; updatedAt: number; messages: MessageWithParts[] }>
}

function storeFile(): string {
  return join(app.getPath('userData'), 'claude-threads.json')
}

function contentParts(sessionId: string, messageId: string, content: unknown): Part[] {
  if (!Array.isArray(content)) return []
  const firstTextIndex = content.findIndex((block) => (
    Boolean(block) && typeof block === 'object' && (block as { type?: string }).type === 'text'
  ))
  return content.flatMap<Part>((block, index): Part[] => {
    if (!block || typeof block !== 'object') return []
    const item = block as Record<string, unknown>
    if (item.type === 'text' || item.type === 'thinking') {
      return [{
        // Claude's streaming deltas use this id for the first text block. Keep
        // the completed message on that identity so the final event replaces
        // the live projection instead of rendering a second copy.
        id: item.type === 'text' && index === firstTextIndex
          ? `${messageId}-text`
          : `${messageId}-${String(item.type)}-${index}`,
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
  private readonly command: string
  private processes = new Map<string, ClaudeProcess>()
  private store: ClaudeStore = { version: 1, sessions: {} }
  private threadBus?: ThreadBusConnection

  constructor(cwd?: string, command = 'claude') {
    this.projectPath = cwd ?? ''
    this.command = command
  }

  async start(): Promise<void> {
    try {
      this.version = execFileSync(this.command, ['--version'], { encoding: 'utf8', timeout: 2500 }).trim()
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
    for (const process of this.processes.values()) process.child.kill()
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

  async sessionCreate(title?: string, directory?: string): Promise<SessionInfo> {
    const id = randomUUID()
    const time = Date.now()
    const projectPath = directory || this.projectPath
    this.store.sessions[id] = { title, projectPath, createdAt: time, updatedAt: time, messages: [] }
    this.save()
    return { id, title, directory: projectPath, time: { created: time, updated: time } }
  }

  async sessionDelete(id: string): Promise<void> {
    this.processes.get(id)?.child.kill()
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
    const mode = claudePermissionMode(options?.mode)
    const threadBusConfig = this.threadBus ? JSON.stringify({
      mcpServers: {
        boss_thread_bus: {
          type: 'http',
          url: `${this.threadBus.url}/mcp`,
          headers: {
            Authorization: 'Bearer ${BOSS_THREAD_BUS_TOKEN}',
            'X-Boss-Backend': 'claude',
            'X-Boss-Thread': '${BOSS_NATIVE_THREAD_ID}'
          }
        }
      }
    }) : ''
    const allowedThreadTools = [
      'mcp__boss_thread_bus__boss_threads_list',
      'mcp__boss_thread_bus__boss_threads_read',
      'mcp__boss_thread_bus__boss_threads_send',
      'mcp__boss_thread_bus__boss_threads_reply',
      'mcp__boss_thread_bus__boss_threads_spawn_worktree',
      ...QA_TOOL_DEFINITIONS.map((tool) => `mcp__boss_thread_bus__${tool.name}`),
      ...(this.threadBus?.agentToolNames() ?? []).map((name) => `mcp__boss_thread_bus__${name}`)
    ].join(',')
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--input-format', 'stream-json',
      '--permission-prompt-tool', 'stdio',
      '--permission-mode', mode,
      '--append-system-prompt', QA_GUIDANCE,
      ...(threadBusConfig ? ['--mcp-config', threadBusConfig, '--allowedTools', allowedThreadTools] : []),
      ...(options?.strictTools && threadBusConfig ? ['--strict-mcp-config'] : []),
      ...(hasHistory ? [`--resume=${sessionId}`] : [`--session-id=${sessionId}`]),
      ...(options?.model?.modelID ? ['--model', options.model.modelID] : []),
      ...(options?.model?.variant ? ['--effort', options.model.variant] : [])
    ]
    const child = spawn(this.command, args, {
      cwd: record.projectPath || this.projectPath || globalThis.process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...globalThis.process.env,
        ...(this.threadBus ? {
          BOSS_THREAD_BUS_TOKEN: this.threadBus.tokenFor('claude', sessionId),
          BOSS_NATIVE_THREAD_ID: sessionId
        } : {})
      }
    })
    const process: ClaudeProcess = { child, permissions: new Map() }
    this.processes.set(sessionId, process)
    this.emit({ type: 'session.status', sessionID: sessionId, status: { type: 'busy' } })

    let buffer = ''
    let assistantId: string = randomUUID()
    let liveText = ''
    const initializeRequestId = `boss-init-${randomUUID()}`
    let promptSent = false
    const sendPrompt = (): void => {
      if (promptSent) return
      promptSent = true
      writeControl(child, {
        type: 'user',
        session_id: sessionId,
        message: { role: 'user', content: prompt },
        parent_tool_use_id: null
      })
    }
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
            if (value.type === 'control_response') {
              const response = value.response as Record<string, unknown> | undefined
              if (response?.request_id === initializeRequestId && response.subtype === 'success') sendPrompt()
            } else if (value.type === 'control_request') {
              const permission = parseClaudePermission(value)
              if (permission) {
                process.permissions.set(permission.requestId, permission)
                this.emit({
                  type: 'permission.asked',
                  permission: {
                    id: permission.requestId,
                    sessionID: sessionId,
                    permission: permission.toolName,
                    patterns: [permission.title ?? permission.description ?? permission.displayName ?? ''].filter(Boolean),
                    metadata: { ...permission.input, title: permission.title, description: permission.description },
                    tool: { callID: permission.toolUseId },
                    time: { created: Date.now() }
                  }
                })
              }
            } else if (value.type === 'system' && value.subtype === 'init' && Array.isArray(value.mcp_server_errors) && value.mcp_server_errors.length > 0) {
              this.emit({
                type: 'session.error',
                sessionID: sessionId,
                error: `Claude Code could not load BOSS agent tools: ${value.mcp_server_errors.map(String).join('; ')}`
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
            } else if (value.type === 'result') {
              if (value.subtype !== 'success') {
                this.emit({ type: 'session.error', sessionID: sessionId, error: String(value.error ?? value.result ?? 'Claude Code failed.') })
              }
              child.stdin?.end()
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
      for (const permissionId of process.permissions.keys()) {
        this.emit({ type: 'permission.replied', sessionID: sessionId, permissionID: permissionId, response: 'reject' })
      }
      this.processes.delete(sessionId)
      if (code && code !== 0) this.emit({ type: 'session.error', sessionID: sessionId, error: stderr.trim() || `Claude Code exited with ${code}.` })
      this.emit({ type: 'session.status', sessionID: sessionId, status: { type: 'idle' } })
      this.emit({ type: 'session.idle', sessionID: sessionId })
    })
    writeControl(child, {
      type: 'control_request',
      request_id: initializeRequestId,
      request: { subtype: 'initialize', hooks: null }
    })
  }

  async abort(sessionId: string): Promise<void> {
    this.processes.get(sessionId)?.child.kill('SIGINT')
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
  async permissionRespond(sessionId: string, permissionId: string, response: 'once' | 'always' | 'reject'): Promise<void> {
    const process = this.processes.get(sessionId)
    const pending = process?.permissions.get(permissionId)
    if (!process || !pending) throw new Error('Claude Code is no longer waiting for this approval.')
    writeControl(process.child, claudePermissionResponse(permissionId, pending, response))
    process.permissions.delete(permissionId)
    this.emit({ type: 'permission.replied', sessionID: sessionId, permissionID: permissionId, response })
  }
  async diffGet(_sessionId: string, _messageId?: string): Promise<FileDiff[]> { return [] }
  async fileTree(_path?: string): Promise<FileNode[]> { return [] }
  async fileContent(path: string): Promise<FileContent> { return { path, content: '' } }
  async fork(sessionId: string): Promise<SessionInfo> { return { id: sessionId } }
  async revert(_sessionId: string, _messageId: string): Promise<void> {}
  async unrevert(_sessionId: string): Promise<void> {}
  async compact(_sessionId: string): Promise<void> {}
}
