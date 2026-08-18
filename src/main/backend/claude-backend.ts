import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { resolveBackendBin } from '../backend-bin'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Backend, McpServerConfig, ModelInfo, ThinkingLevel } from './backend'
import { THREAD_BUSY_ERROR } from '@shared/backend'
import type { BackendMessageOptions, BackendModeId } from '@shared/backend'
import type { ThreadBusConnection } from '@shared/thread-bus'
import { QA_GUIDANCE, QA_TOOL_DEFINITIONS } from '@shared/qa'
import type { EventMessage, SessionInfo, MessageWithParts, Todo, FileDiff, FileNode, FileContent, Part } from '@shared/opencode'
import { SessionDirectories } from './session-directory'
import { textFromParts } from './manager'
import { claudeExitError, claudeMessageContent, claudePermissionMode, claudePermissionResponse, claudeQuestionResponse, claudeResultError, claudeStreamedPartId, parseClaudePermission, parseClaudeQuestions } from './claude-protocol'
import type { ClaudePermissionRequest } from './claude-protocol'

interface ClaudeProcess {
  child: ChildProcess
  sessionId: string
  permissions: Map<string, ClaudePermissionRequest>
  intentionallyStopped?: boolean
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
  const firstThinkingIndex = content.findIndex((block) => (
    Boolean(block) && typeof block === 'object' && (block as { type?: string }).type === 'thinking'
  ))
  return content.flatMap<Part>((block, index): Part[] => {
    if (!block || typeof block !== 'object') return []
    const item = block as Record<string, unknown>
    if (item.type === 'text' || item.type === 'thinking') {
      return [{
        id: claudeStreamedPartId(messageId, String(item.type), index, firstTextIndex, firstThinkingIndex),
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
  private readonly sessionDirectories = new SessionDirectories()
  private version = ''
  private healthy = false
  private readonly command: string
  /** Turns that have not settled yet. A session leaves this the moment its
   *  turn ends, which is what decides whether a new message can be sent. */
  private processes = new Map<string, ClaudeProcess>()
  /** Children that are still alive, including ones whose turn already
   *  settled. Claude outlives its own result, so cleanup needs its own list. */
  private lingering = new Set<ClaudeProcess>()
  private store: ClaudeStore = { version: 1, sessions: {} }
  private threadBus?: ThreadBusConnection

  constructor(cwd?: string, command = resolveBackendBin('claude')) {
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
    // Every live child, not just the ones mid-turn: a settled turn can still
    // have a process waiting to exit, and shutting down has to take those too.
    for (const process of this.lingering) process.child.kill()
    this.lingering.clear()
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

  /** Put a thread in its own checkout.
   *
   *  The manager owns which project a thread belongs to and calls this on every
   *  lookup. Without it a session kept whatever path it was created with, so a
   *  thread moved to a worktree, or created before its project was known, ran
   *  in the wrong directory and reasoned about the wrong repository.
   *
   *  Also written to the session record, which is what sessionsList reports and
   *  what survives a restart. */
  setSessionDirectory(id: string, directory: string): void {
    this.sessionDirectories.set(id, directory)
    const record = this.store.sessions[id]
    if (!record || !directory || record.projectPath === directory) return
    record.projectPath = directory
    this.save()
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
    this.killSession(id)
    this.sessionDirectories.forget(id)
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
    // The same refusal main makes, named the same way. Claude holds its turn
    // slot until the result arrives, which is a moment later than main clearing
    // busyThreads on idle. A message sent inside that gap passes main's check
    // and lands here, so this has to be a busy signal the renderer recognises:
    // described in prose it looked like an unrelated failure, and the renderer
    // dropped the message instead of queueing it.
    if (this.processes.has(sessionId)) throw new Error(THREAD_BUSY_ERROR)
    const record = this.record(sessionId)
    // What Claude is sent, which carries an attached image as a block rather
    // than describing it. The transcript echo below stays text: main records
    // the image part itself, so repeating it here would show it twice.
    const content = claudeMessageContent(parts)
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
      'mcp__boss_thread_bus__boss_threads_use_worktree',
      'mcp__boss_thread_bus__boss_threads_leave_worktree',
      'mcp__boss_thread_bus__boss_plugin_list',
      'mcp__boss_thread_bus__boss_plugin_create',
      'mcp__boss_thread_bus__boss_plugin_reload',
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
      '--append-system-prompt', options?.context ? `${options.context}\n\n${QA_GUIDANCE}` : QA_GUIDANCE,
      ...(threadBusConfig ? ['--mcp-config', threadBusConfig, '--allowedTools', allowedThreadTools] : []),
      ...(options?.strictTools && threadBusConfig ? ['--strict-mcp-config'] : []),
      ...(hasHistory ? [`--resume=${sessionId}`] : [`--session-id=${sessionId}`]),
      ...(options?.model?.modelID ? ['--model', options.model.modelID] : []),
      ...(options?.model?.variant ? ['--effort', options.model.variant] : [])
    ]
    const child = spawn(this.command, args, {
      cwd: this.sessionDirectories.resolve(sessionId, record.projectPath || this.projectPath) || globalThis.process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...globalThis.process.env,
        ...(this.threadBus ? {
          BOSS_THREAD_BUS_TOKEN: this.threadBus.tokenFor('claude', sessionId),
          BOSS_NATIVE_THREAD_ID: sessionId
        } : {})
      }
    })
    const process: ClaudeProcess = { child, sessionId, permissions: new Map() }
    this.processes.set(sessionId, process)
    this.lingering.add(process)
    this.emit({ type: 'session.status', sessionID: sessionId, status: { type: 'busy' } })

    let buffer = ''
    let assistantId: string = randomUUID()
    let liveText = ''
    let liveThinking = ''
    const initializeRequestId = `boss-init-${randomUUID()}`
    let promptSent = false
    const sendPrompt = (): void => {
      if (promptSent) return
      promptSent = true
      writeControl(child, {
        type: 'user',
        session_id: sessionId,
        message: { role: 'user', content },
        parent_tool_use_id: null
      })
    }
    // Ends the turn exactly once. It ends at the result, or at exit if the
    // process dies before producing one; both paths call this.
    let settled = false
    const settle = (): void => {
      if (settled) return
      settled = true
      // Free the slot before announcing idle, not when the child exits. Claude
      // outlives its own result, and whatever acts on idle — a queued follow-up
      // above all — sends the next message from inside these emits. Holding the
      // slot until exit failed that send as busy and left the follow-up
      // sitting in the queue.
      if (this.processes.get(sessionId) === process) this.processes.delete(sessionId)
      this.emit({ type: 'session.status', sessionID: sessionId, status: { type: 'idle' } })
      this.emit({ type: 'session.idle', sessionID: sessionId })
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
              const questions = permission ? parseClaudeQuestions(permission) : undefined
              if (permission && questions) {
                // A question, not a request for consent. Asking "allow this
                // tool?" hid what was being asked, and denying it reported a
                // dismissal the user never made.
                process.permissions.set(permission.requestId, permission)
                this.emit({
                  type: 'question.asked',
                  question: {
                    id: permission.requestId,
                    sessionID: sessionId,
                    questions: questions.map((item) => ({
                      question: item.question,
                      header: item.header,
                      options: item.options.map((option) => ({ label: option.label, description: option.description })),
                      multiple: item.multiple,
                      // Claude's own tool always allows a written answer.
                      custom: true
                    })),
                    tool: { callID: permission.toolUseId }
                  }
                })
              } else if (permission) {
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
                liveThinking = ''
              } else if (event?.type === 'content_block_delta' && delta?.type === 'text_delta') {
                liveText += String(delta.text ?? '')
                this.upsert(sessionId, {
                  info: { id: assistantId, sessionID: sessionId, role: 'assistant', time: { created: Date.now() } },
                  parts: [{ id: `${assistantId}-text`, type: 'text', sessionID: sessionId, messageID: assistantId, text: liveText }]
                })
              } else if (event?.type === 'content_block_delta' && delta?.type === 'thinking_delta') {
                // Without this a long think looked like nothing was happening:
                // the reasoning arrived in one lump with the finished message,
                // where every other backend shows it accumulating.
                liveThinking += String(delta.thinking ?? '')
                this.upsert(sessionId, {
                  info: { id: assistantId, sessionID: sessionId, role: 'assistant', time: { created: Date.now() } },
                  parts: [{ id: `${assistantId}-thinking`, type: 'reasoning', sessionID: sessionId, messageID: assistantId, text: liveThinking }]
                })
              }
            } else if (value.type === 'result') {
              const error = claudeResultError(value, process.intentionallyStopped)
              if (error) this.emit({ type: 'session.error', sessionID: sessionId, error })
              // The turn is over here, whatever the process does next. Waiting
              // for exit left a thread labelled "Working" after its reply was
              // finished, since the process can outlive the result — and now
              // does whenever a question is still waiting to be answered.
              settle()
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
      // Nothing can be answered once the process is gone, so clear whatever is
      // still on screen. A question is withdrawn rather than reported as a
      // denied permission, which would leave its card waiting for an answer
      // that can no longer go anywhere.
      for (const [requestId, pending] of process.permissions) {
        if (parseClaudeQuestions(pending)) {
          this.emit({ type: 'question.rejected', sessionID: sessionId, requestID: requestId })
        } else {
          this.emit({ type: 'permission.replied', sessionID: sessionId, permissionID: requestId, response: 'reject' })
        }
      }
      // Only if this child still owns the slot. Once its turn settled, a queued
      // follow-up may already hold it, and that newer turn must survive.
      if (this.processes.get(sessionId) === process) this.processes.delete(sessionId)
      this.lingering.delete(process)
      const exitError = claudeExitError(code, stderr, process.intentionallyStopped)
      if (exitError) this.emit({ type: 'session.error', sessionID: sessionId, error: exitError })
      settle()
    })
    writeControl(child, {
      type: 'control_request',
      request_id: initializeRequestId,
      request: { subtype: 'initialize', hooks: null }
    })
  }

  /** This session's newest child that is still alive, whether or not its turn
   *  has ended. A turn ends at the result, but the process stays up while a
   *  question waits, and the control channel is still open until it exits. */
  private liveProcess(sessionId: string): ClaudeProcess | undefined {
    const running = this.processes.get(sessionId)
    if (running) return running
    let latest: ClaudeProcess | undefined
    for (const process of this.lingering) {
      if (process.sessionId === sessionId) latest = process
    }
    return latest
  }

  /** The child holding this request. A session can briefly have two processes
   *  — one settled with a question still open, one running the next message —
   *  so the answer has to go to whichever actually asked. */
  private awaiting(sessionId: string, requestId: string): ClaudeProcess | undefined {
    for (const process of this.lingering) {
      if (process.sessionId === sessionId && process.permissions.has(requestId)) return process
    }
    return undefined
  }

  /** Stop this session's child and give up its turn slot at once, so the next
   *  message can be sent without waiting for the process to exit. */
  private killSession(sessionId: string, signal: NodeJS.Signals = 'SIGKILL'): void {
    this.processes.delete(sessionId)
    // Every child of this session, not only the one mid-turn: a settled process
    // holding an unanswered question is still running and still has to stop.
    for (const process of this.lingering) {
      if (process.sessionId === sessionId) {
        process.intentionallyStopped = true
        process.child.kill(signal)
      }
    }
  }

  async abort(sessionId: string): Promise<void> {
    this.killSession(sessionId, 'SIGINT')
  }

  /** Tell a running Claude Code its permission mode changed.
   *
   *  Claude accepts set_permission_mode on the same control channel it sends
   *  permission requests over, and applies it to every request after it. That
   *  keeps Claude's own graduated Auto in charge: it goes on escalating the
   *  tools it wants confirmed instead of BOSS blanket-approving them.
   *
   *  Returns false when there is no live process, so the caller can say the
   *  mode applies from the next message rather than immediately. */
  async permissionModeSet(sessionId: string, mode: BackendModeId): Promise<boolean> {
    const process = this.liveProcess(sessionId)
    if (!process?.child.stdin?.writable) return false
    writeControl(process.child, {
      type: 'control_request',
      request_id: `boss-mode-${randomUUID()}`,
      request: { subtype: 'set_permission_mode', mode: claudePermissionMode(mode) }
    })
    return true
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
    const process = this.awaiting(sessionId, permissionId)
    const pending = process?.permissions.get(permissionId)
    if (!process || !pending) throw new Error('Claude Code is no longer waiting for this approval.')
    writeControl(process.child, claudePermissionResponse(permissionId, pending, response))
    process.permissions.delete(permissionId)
    this.emit({ type: 'permission.replied', sessionID: sessionId, permissionID: permissionId, response })
  }
  /** Hand back what the user chose, as the result of the tool Claude called.
   *  Answers travel on the same control channel as approvals, so a question is
   *  answered rather than allowed or denied. */
  async questionRespond(sessionId: string, requestId: string, answers: string[][]): Promise<void> {
    const process = this.awaiting(sessionId, requestId)
    const pending = process?.permissions.get(requestId)
    if (!process || !pending) throw new Error('Claude Code is no longer waiting for this answer.')
    writeControl(process.child, claudeQuestionResponse(requestId, pending, answers))
    process.permissions.delete(requestId)
    this.emit({ type: 'question.replied', sessionID: sessionId, requestID: requestId, answers })
  }

  async diffGet(_sessionId: string, _messageId?: string): Promise<FileDiff[]> { return [] }
  async fileTree(_path?: string): Promise<FileNode[]> { return [] }
  async fileContent(path: string): Promise<FileContent> { return { path, content: '' } }
  async fork(sessionId: string): Promise<SessionInfo> { return { id: sessionId } }
  async revert(_sessionId: string, _messageId: string): Promise<void> {}
  async unrevert(_sessionId: string): Promise<void> {}
  async compact(_sessionId: string): Promise<void> {}
}
