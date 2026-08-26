import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolveBackendBin } from '../backend-bin'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { query, type Query, type SDKMessage, type SDKUserMessage, type PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { Backend, McpServerConfig, ModelInfo, ThinkingLevel } from './backend'
import { THREAD_BUSY_ERROR } from '@shared/backend'
import type { BackendMessageOptions, BackendModeId } from '@shared/backend'
import type { ThreadBusConnection } from '@shared/thread-bus'
import { QA_GUIDANCE, QA_TOOL_DEFINITIONS } from '@shared/qa'
import type { EventMessage, SessionInfo, MessageWithParts, Todo, FileDiff, FileNode, FileContent, Part } from '@shared/opencode'
import { SessionDirectories } from './session-directory'
import { unpackedAsarPath } from './claude-executable'
import { claudeMessageContent, claudePermissionMode, claudePermissionDecision, claudeQuestionInput, claudeResultError, claudeStreamedPartId, claudeTranscriptParts, parseClaudeQuestions } from './claude-protocol'
import type { ClaudePermissionRequest } from './claude-protocol'
import { toolLabel } from '@shared/tool-label'
import { compactionCompletedEvents, compactionStartedEvent, type CompactionTrigger } from './compaction-events'

const requireFromMain = createRequire(import.meta.url)

/**
 * electron-builder unpacks the SDK's native package, but Node's package
 * resolver still returns the corresponding virtual `app.asar/...` path. A
 * child process must receive the literal `app.asar.unpacked/...` filesystem
 * path on packaged builds or macOS reports `spawn ENOTDIR`.
 */
function packagedSdkClaudeBinary(): string | undefined {
  if (!app.isPackaged) return undefined
  try {
    const sdkEntry = requireFromMain.resolve('@anthropic-ai/claude-agent-sdk')
    const sdkRequire = createRequire(sdkEntry)
    const platformPackage = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
    const resolved = sdkRequire.resolve(`${platformPackage}/claude`)
    return unpackedAsarPath(resolved)
  } catch {
    return undefined
  }
}

/** A turn in flight, and the questions it is still waiting on.
 *
 *  The SDK owns the subprocess, so this holds the run rather than a child: the
 *  Query for control calls, and a resolver per outstanding permission because
 *  canUseTool is a promise the SDK awaits rather than a message BOSS writes
 *  back. */
interface ClaudeRun {
  sessionId: string
  query: Query
  permissions: Map<string, ClaudePermissionRequest>
  /** Settles the canUseTool promise the SDK is awaiting for this request. */
  waiting: Map<string, (result: PermissionResult) => void>
  intentionallyStopped?: boolean
}

interface ClaudeStore {
  version: 1
  sessions: Record<string, { title?: string; projectPath: string; createdAt: number; updatedAt: number; messages: MessageWithParts[] }>
}

const SAVE_DEBOUNCE_MS = 100

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
        state: {
          status: 'running' as const,
          tool: String(item.name ?? 'tool'),
          // Without a title the transcript heads every call with the tool's name, so a run of
          // shell calls reads as "Bash" fifteen times. Codex already names its own this way.
          title: toolLabel(String(item.name ?? ''), item.input),
          input: item.input
        }
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
  private runs = new Map<string, ClaudeRun>()
  /** Children that are still alive, including ones whose turn already
   *  settled. Claude outlives its own result, so cleanup needs its own list. */
  private lingering = new Set<ClaudeRun>()
  private store: ClaudeStore = { version: 1, sessions: {} }
  private saveTimer?: ReturnType<typeof setTimeout>
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
    for (const run of this.lingering) void run.query.interrupt().catch(() => {})
    this.lingering.clear()
    this.runs.clear()
    // A debounced write may still be pending; shutting down without it would
    // drop the tail of the last turn.
    if (this.saveTimer) this.save()
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
  /** Write the whole store synchronously. Callers on the hot streaming path
   *  must use saveSoon() instead: this serialises every session and blocks the
   *  main process, which also serves IPC, so a per-token call here freezes the
   *  UI once the store grows. Indentation is dropped because nothing reads this
   *  file by eye and it is a third of the bytes. */
  private save(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = undefined
    }
    try { writeFileSync(storeFile(), JSON.stringify(this.store)) } catch { /* keep in memory */ }
  }

  /** Coalesce bursts of streaming writes into one flush. Deltas arrive per
   *  token per thread; persisting each one is pure waste when the next
   *  supersedes it milliseconds later. */
  private saveSoon(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      this.save()
    }, SAVE_DEBOUNCE_MS)
    this.saveTimer.unref?.()
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
    this.saveSoon()
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
      this.saveSoon()
    }
  }

  async sendMessage(sessionId: string, parts: unknown[], options?: BackendMessageOptions): Promise<void> {
    // The same refusal main makes, named the same way. Claude holds its turn
    // slot until the result arrives, which is a moment later than main clearing
    // busyThreads on idle. A message sent inside that gap passes main's check
    // and lands here, so this has to be a busy signal the renderer recognises:
    // described in prose it looked like an unrelated failure, and the renderer
    // dropped the message instead of queueing it.
    if (this.runs.has(sessionId)) throw new Error(THREAD_BUSY_ERROR)
    const record = this.record(sessionId)
    // What Claude is sent carries an attached image as a block; the durable
    // transcript below keeps the corresponding file part so the user sees the
    // same attachment after a reload.
    const content = claudeMessageContent(parts)
    const userId = randomUUID()
    this.upsert(sessionId, {
      info: { id: userId, sessionID: sessionId, role: 'user', time: { created: Date.now() } },
      parts: claudeTranscriptParts(parts, sessionId, userId)
    })

    const hasHistory = record.messages.some((message) => message.info.role === 'assistant')
    const mode = claudePermissionMode(options?.mode)
    const packagedBinary = packagedSdkClaudeBinary()
    const cwd = this.sessionDirectories.resolve(sessionId, record.projectPath || this.projectPath)
      || globalThis.process.cwd()

    let run: ClaudeRun
    const permissions = new Map<string, ClaudePermissionRequest>()
    const waiting = new Map<string, (result: PermissionResult) => void>()

    // Asked for consent, or for an answer. The SDK awaits this promise, so the
    // decision is resolved from permissionRespond/questionRespond rather than
    // written back down a pipe.
    const canUseTool = (
      toolName: string,
      input: Record<string, unknown>,
      context: {
        suggestions?: unknown[]
        title?: string
        description?: string
        displayName?: string
        toolUseID: string
        requestId: string
      }
    ): Promise<PermissionResult> => {
      const pending: ClaudePermissionRequest = {
        requestId: context.requestId,
        toolName,
        input,
        suggestions: context.suggestions ?? [],
        title: context.title,
        description: context.description,
        displayName: context.displayName,
        toolUseId: context.toolUseID
      }
      permissions.set(pending.requestId, pending)
      const questions = parseClaudeQuestions(pending)
      if (questions) {
        // A question, not a request for consent. Asking "allow this tool?" hid
        // what was being asked, and denying it reported a dismissal the user
        // never made.
        this.emit({
          type: 'question.asked',
          question: {
            id: pending.requestId,
            sessionID: sessionId,
            questions: questions.map((item) => ({
              question: item.question,
              header: item.header,
              options: item.options.map((option) => ({ label: option.label, description: option.description })),
              multiple: item.multiple,
              // Claude's own tool always allows a written answer.
              custom: true
            })),
            tool: { callID: pending.toolUseId }
          }
        })
      } else {
        this.emit({
          type: 'permission.asked',
          permission: {
            id: pending.requestId,
            sessionID: sessionId,
            permission: pending.toolName,
            patterns: [pending.title ?? pending.description ?? pending.displayName ?? ''].filter(Boolean),
            metadata: { ...pending.input, title: pending.title, description: pending.description },
            tool: { callID: pending.toolUseId },
            time: { created: Date.now() }
          }
        })
      }
      return new Promise<PermissionResult>((resolve) => { waiting.set(pending.requestId, resolve) })
    }

    // Streaming input, not a bare prompt. Anthropic documents single-message
    // input as the limited mode: it takes no image blocks, no queued messages
    // and no interruption, and a content-block array sent that way ends the
    // turn silently — no assistant message, no result, no error. BOSS attaches
    // images and interrupts runs, so the message goes through a generator.
    async function* input(): AsyncGenerator<SDKUserMessage> {
      yield {
        type: 'user',
        message: { role: 'user', content },
        parent_tool_use_id: null
      } as SDKUserMessage
    }

    const session = query({
      prompt: input(),
      options: {
        cwd,
        // The user's own binary when one is configured, so a BOSS_CLAUDE_BIN or
        // a settings path still wins. Otherwise the SDK runs the version it
        // ships, which is the one BOSS is built against.
        ...(this.command !== 'claude'
          ? { pathToClaudeCodeExecutable: this.command }
          : packagedBinary
            ? { pathToClaudeCodeExecutable: packagedBinary }
            : {}),
        permissionMode: mode,
        canUseTool: canUseTool as never,
        includePartialMessages: true,
        appendSystemPrompt: options?.context ? `${options.context}\n\n${QA_GUIDANCE}` : QA_GUIDANCE,
        ...(hasHistory ? { resume: sessionId } : { sessionId }),
        ...(options?.model?.modelID ? { model: options.model.modelID } : {}),
        ...(this.threadBus ? {
          mcpServers: {
            boss_thread_bus: {
              type: 'http' as const,
              url: `${this.threadBus.url}/mcp`,
              headers: {
                Authorization: `Bearer ${this.threadBus.tokenFor('claude', sessionId)}`,
                'X-Boss-Backend': 'claude',
                'X-Boss-Thread': sessionId
              }
            }
          },
          allowedTools: this.threadBusTools(),
          ...(options?.strictTools ? { strictMcpConfig: true } : {})
        } : {})
      }
    } as never) as Query

    run = { sessionId, query: session, permissions, waiting }
    this.runs.set(sessionId, run)
    this.lingering.add(run)
    this.emit({ type: 'session.status', sessionID: sessionId, status: { type: 'busy' } })

    // Ends the turn exactly once. It ends at the result, or when the stream
    // finishes if no result arrived; both paths call this.
    let settled = false
    const settle = (): void => {
      if (settled) return
      settled = true
      // Free the slot before announcing idle. Claude outlives its own result,
      // and whatever acts on idle — a queued follow-up above all — sends the
      // next message from inside these emits. Holding the slot until the
      // stream closed failed that send as busy and left the follow-up sitting
      // in the queue.
      if (this.runs.get(sessionId) === run) this.runs.delete(sessionId)
      this.emit({ type: 'session.status', sessionID: sessionId, status: { type: 'idle' } })
      this.emit({ type: 'session.idle', sessionID: sessionId })
    }

    void this.consume(sessionId, run, session, settle)
  }

  /** Read a run's messages until the stream ends.
   *
   *  Separate from sendMessage so the send resolves as soon as the turn starts,
   *  the way it did when the work was a spawned child rather than an async
   *  iterator. */
  private async consume(sessionId: string, run: ClaudeRun, session: Query, settle: () => void): Promise<void> {
    let assistantId: string = randomUUID()
    let liveText = ''
    let liveThinking = ''
    try {
      for await (const message of session as AsyncIterable<SDKMessage>) {
        const value = message as unknown as Record<string, unknown>
        if (value.type === 'system' && value.subtype === 'status') {
          if (value.status === 'compacting') {
            this.emit(compactionStartedEvent(sessionId))
          } else if (value.compact_result === 'failed') {
            this.emit({
              type: 'session.error',
              sessionID: sessionId,
              error: String(value.compact_error ?? 'Claude Code could not compact the context.')
            })
          }
        } else if (value.type === 'system' && value.subtype === 'compact_boundary') {
          const metadata = (value.compact_metadata ?? {}) as Record<string, unknown>
          const trigger: CompactionTrigger = metadata.trigger === 'auto' || metadata.trigger === 'manual'
            ? metadata.trigger
            : 'unknown'
          for (const event of compactionCompletedEvents(sessionId, {
            trigger,
            preTokens: typeof metadata.pre_tokens === 'number' ? metadata.pre_tokens : undefined,
            postTokens: typeof metadata.post_tokens === 'number' ? metadata.post_tokens : undefined
          })) this.emit(event)
        } else if (value.type === 'system' && value.subtype === 'init' && Array.isArray(value.mcp_server_errors) && value.mcp_server_errors.length > 0) {
          this.emit({
            type: 'session.error',
            sessionID: sessionId,
            error: `Claude Code could not load BOSS agent tools: ${value.mcp_server_errors.map(String).join('; ')}`
          })
        } else if (value.type === 'assistant') {
          const inner = value.message as { id?: string; content?: unknown; model?: string } | undefined
          assistantId = inner?.id ?? assistantId
          this.upsert(sessionId, {
            info: { id: assistantId, sessionID: sessionId, role: 'assistant', model: inner?.model ? { id: inner.model, provider: 'anthropic' } : undefined, time: { created: Date.now() } },
            parts: contentParts(sessionId, assistantId, inner?.content)
          })
        } else if (value.type === 'user') {
          const inner = value.message as { content?: unknown } | undefined
          this.applyToolResults(sessionId, inner?.content)
        } else if (value.type === 'stream_event') {
          const event = value.event as Record<string, unknown> | undefined
          const delta = event?.delta as Record<string, unknown> | undefined
          if (event?.type === 'message_start') {
            const inner = event.message as { id?: string } | undefined
            assistantId = inner?.id ?? assistantId
            liveText = ''
            liveThinking = ''
          } else if (event?.type === 'content_block_delta' && delta?.type === 'text_delta') {
            liveText += String(delta.text ?? '')
            this.upsert(sessionId, {
              info: { id: assistantId, sessionID: sessionId, role: 'assistant', time: { created: Date.now() } },
              parts: [{ id: `${assistantId}-text`, type: 'text', sessionID: sessionId, messageID: assistantId, text: liveText }]
            })
          } else if (event?.type === 'content_block_delta' && delta?.type === 'thinking_delta') {
            // Without this a long think looked like nothing was happening: the
            // reasoning arrived in one lump with the finished message, where
            // every other backend shows it accumulating.
            liveThinking += String(delta.thinking ?? '')
            this.upsert(sessionId, {
              info: { id: assistantId, sessionID: sessionId, role: 'assistant', time: { created: Date.now() } },
              parts: [{ id: `${assistantId}-thinking`, type: 'reasoning', sessionID: sessionId, messageID: assistantId, text: liveThinking }]
            })
          }
        } else if (value.type === 'result') {
          const error = claudeResultError(value, run.intentionallyStopped)
          if (error) this.emit({ type: 'session.error', sessionID: sessionId, error })
          // The turn is over here, whatever the stream does next. Waiting for
          // it to close left a thread labelled "Working" after its reply was
          // finished, since the run outlives the result — and now does whenever
          // a question is still waiting to be answered.
          settle()
        }
      }
    } catch (error) {
      // An aborted run rejects the iterator; that is the expected end of Stop &
      // redirect rather than a failure worth reporting.
      if (!run.intentionallyStopped) {
        this.emit({ type: 'session.error', sessionID: sessionId, error: (error as Error).message })
      }
    } finally {
      // Nothing can be answered once the run is gone, so clear whatever is
      // still on screen. A question is withdrawn rather than reported as a
      // denied permission, which would leave its card waiting for an answer
      // that can no longer go anywhere.
      for (const [requestId, pending] of run.permissions) {
        const resolve = run.waiting.get(requestId)
        // Let the SDK's own promise go, or it stays pending for the life of
        // the process.
        resolve?.({ behavior: 'deny', message: 'The run ended before this was answered.', interrupt: false } as PermissionResult)
        if (parseClaudeQuestions(pending)) {
          this.emit({ type: 'question.rejected', sessionID: sessionId, requestID: requestId })
        } else {
          this.emit({ type: 'permission.replied', sessionID: sessionId, permissionID: requestId, response: 'reject' })
        }
      }
      run.permissions.clear()
      run.waiting.clear()
      // Only if this run still owns the slot. Once its turn settled, a queued
      // follow-up may already hold it, and that newer turn must survive.
      if (this.runs.get(sessionId) === run) this.runs.delete(sessionId)
      this.lingering.delete(run)
      settle()
    }
  }

  /** The BOSS tools a thread may call, named the way Claude namespaces them. */
  private threadBusTools(): string[] {
    return [
      'mcp__boss_thread_bus__boss_threads_list',
      'mcp__boss_thread_bus__boss_threads_read',
      'mcp__boss_thread_bus__boss_threads_send',
      'mcp__boss_thread_bus__boss_threads_reply',
      'mcp__boss_thread_bus__boss_threads_spawn_worktree',
      'mcp__boss_thread_bus__boss_threads_use_worktree',
      'mcp__boss_thread_bus__boss_threads_leave_worktree',
      'mcp__boss_thread_bus__boss_git_create_change_request',
      'mcp__boss_thread_bus__boss_reports_create',
      'mcp__boss_thread_bus__boss_reports_update',
      'mcp__boss_thread_bus__boss_workflow_list',
      'mcp__boss_thread_bus__boss_workflow_create',
      'mcp__boss_thread_bus__boss_workflow_update',
      'mcp__boss_thread_bus__boss_workflow_run',
      'mcp__boss_thread_bus__boss_workflow_runs',
      ...QA_TOOL_DEFINITIONS.map((tool) => `mcp__boss_thread_bus__${tool.name}`),
      ...(this.threadBus?.agentToolNames() ?? []).map((name) => `mcp__boss_thread_bus__${name}`)
    ]
  }

  /** This session's newest run that is still alive, whether or not its turn
   *  has ended. A turn ends at the result, but the run stays up while a
   *  question waits, and control calls still reach it until the stream closes. */
  private liveRun(sessionId: string): ClaudeRun | undefined {
    const running = this.runs.get(sessionId)
    if (running) return running
    let latest: ClaudeRun | undefined
    for (const run of this.lingering) {
      if (run.sessionId === sessionId) latest = run
    }
    return latest
  }

  /** The run holding this request. A session can briefly have two runs — one
   *  settled with a question still open, one running the next message — so the
   *  answer has to go to whichever actually asked. */
  private awaiting(sessionId: string, requestId: string): ClaudeRun | undefined {
    for (const run of this.lingering) {
      if (run.sessionId === sessionId && run.permissions.has(requestId)) return run
    }
    return undefined
  }

  /** Stop this session's runs and give up its turn slot at once, so the next
   *  message can be sent without waiting for the stream to close. */
  private killSession(sessionId: string): void {
    this.runs.delete(sessionId)
    // Every run of this session, not only the one mid-turn: a settled run
    // holding an unanswered question is still going and still has to stop.
    for (const run of this.lingering) {
      if (run.sessionId === sessionId) {
        run.intentionallyStopped = true
        void run.query.interrupt().catch(() => { /* already gone */ })
      }
    }
  }

  async abort(sessionId: string): Promise<void> {
    this.killSession(sessionId)
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
    const run = this.liveRun(sessionId)
    if (!run) return false
    try {
      await run.query.setPermissionMode(claudePermissionMode(mode))
      return true
    } catch {
      // The run ended between the lookup and the call, so the mode applies
      // from the next message rather than this one.
      return false
    }
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
    const run = this.awaiting(sessionId, permissionId)
    const pending = run?.permissions.get(permissionId)
    const resolve = run?.waiting.get(permissionId)
    if (!run || !pending || !resolve) throw new Error('Claude Code is no longer waiting for this approval.')
    resolve(claudePermissionDecision(pending, response) as PermissionResult)
    run.permissions.delete(permissionId)
    run.waiting.delete(permissionId)
    this.emit({ type: 'permission.replied', sessionID: sessionId, permissionID: permissionId, response })
  }
  /** Hand back what the user chose, as the result of the tool Claude called.
   *  Answers travel on the same control channel as approvals, so a question is
   *  answered rather than allowed or denied. */
  async questionRespond(sessionId: string, requestId: string, answers: string[][]): Promise<void> {
    const run = this.awaiting(sessionId, requestId)
    const pending = run?.permissions.get(requestId)
    const resolve = run?.waiting.get(requestId)
    if (!run || !pending || !resolve) throw new Error('Claude Code is no longer waiting for this answer.')
    // Claude reads the tool result, so the answers go back as the input it will
    // see rather than as a permission decision.
    resolve({ behavior: 'allow', updatedInput: claudeQuestionInput(pending, answers) } as PermissionResult)
    run.permissions.delete(requestId)
    run.waiting.delete(requestId)
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
