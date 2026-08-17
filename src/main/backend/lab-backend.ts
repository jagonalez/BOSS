import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { Backend, McpServerConfig, ModelInfo, ThinkingLevel } from './backend'
import type { BackendMessageOptions, BackendModeId } from '@shared/backend'
import type { EventMessage, FileContent, FileDiff, FileNode, MessageWithParts, SessionInfo, Todo } from '@shared/opencode'
// The explicit extensions keep this module executable under Node's type-stripping test runner.
// @ts-expect-error Application builds use bundler resolution.
import { LabEngine, type EngineGate, type EngineSink } from './lab-engine.ts'
// @ts-expect-error Application builds use bundler resolution.
import { permissionForTool } from './lab-tools.ts'
import type { LabFunctionCall } from './lab-tool-call.ts'
// @ts-expect-error Application builds use bundler resolution.
import { configFromEnv } from './lab-config.ts'

// Electron is pulled in lazily so the backend can be constructed with explicit
// file paths under the test runner (where the electron module is just a binary
// path and has no `app`). The main process passes no options and gets the real
// userData directory.
const nodeRequire = createRequire(import.meta.url)
function userDataFile(name: string): string {
  const { app } = nodeRequire('electron') as typeof import('electron')
  return join(app.getPath('userData'), name)
}

export interface LabBackendOptions {
  storeFile?: string
  configFile?: string
}

/** Same shape as the manager's helper, kept local so this module has no
 *  runtime dependency on modules that import Electron. */
function textFromParts(parts: unknown[]): string {
  return parts
    .map((part) => {
      if (!part || typeof part !== 'object') return ''
      const item = part as { type?: string; text?: string; filename?: string; mime?: string }
      if (item.type === 'file') return `[Attached file: ${item.filename ?? item.mime ?? 'file'}]`
      return item.text ?? ''
    })
    .filter(Boolean)
    .join('\n')
}

interface PendingPermission {
  submitSession: string
  toolName: string
  removeAbortListener?: () => void
  resolve: (decision: 'allow' | 'deny') => void
}

/** BOSS adapter over the Lab harness. All agent behavior lives in the engine;
 *  this class maps engine events to BOSS EventMessages and answers engine
 *  permission requests with the existing permission cards. */
export class LabBackend implements Backend {
  readonly id = 'lab' as const
  private readonly engine: LabEngine
  private eventCb?: (event: EventMessage) => void
  private projectPath = ''
  private healthy = false
  private readonly pendingPermissions = new Map<string, PendingPermission>()
  private readonly liveText = new Map<string, string>()

  constructor(options: LabBackendOptions = {}) {
    this.engine = new LabEngine({
      storeFile: options.storeFile ?? userDataFile('lab-threads.json'),
      configFile: options.configFile ?? userDataFile('lab-config.json'),
      config: configFromEnv(),
      sink: this.sink(),
      gate: { request: (sessionId, call, args, signal) => this.requestPermission(sessionId, call, args, signal) }
    })
    void this.refreshHealth()
  }

  private sink(): EngineSink {
    return {
      onUserMessage: (_sessionId, message) => {
        this.emit({ type: 'message.updated', message: message.info })
        for (const part of message.parts) this.emit({ type: 'message.part.updated', part })
      },
      onAssistantMessage: (_sessionId, message) => {
        this.emit({ type: 'message.updated', message: message.info })
        for (const part of message.parts) this.emit({ type: 'message.part.updated', part })
      },
      onTextDelta: (_sessionId, messageId, delta) => {
        // The engine sends raw deltas; BOSS's part events carry the running
        // text so the renderer can replace the part in place.
        const text = `${this.liveText.get(messageId) ?? ''}${delta}`
        this.liveText.set(messageId, text)
        this.emit({ type: 'message.part.updated', part: { id: `${messageId}-text`, type: 'text', sessionID: _sessionId, messageID: messageId, text } })
      },
      onToolPart: (_sessionId, part) => this.emit({ type: 'message.part.updated', part }),
      onTodos: (sessionId, todos) => this.emit({ type: 'session.todo.updated', sessionID: sessionId, todos }),
      onBusy: (sessionId) => this.emit({ type: 'session.status', sessionID: sessionId, status: { type: 'busy' } }),
      onIdle: (sessionId) => {
        this.emit({ type: 'session.status', sessionID: sessionId, status: { type: 'idle' } })
        this.emit({ type: 'session.idle', sessionID: sessionId })
      },
      onError: (sessionId, error) => {
        this.emit({ type: 'session.status', sessionID: sessionId, status: { type: 'idle' } })
        this.emit({ type: 'session.error', sessionID: sessionId, error })
      }
    }
  }

  private async refreshHealth(): Promise<void> {
    this.healthy = await this.engine.checkHealth()
  }

  async start(): Promise<void> {
    this.engine.start()
    await this.refreshHealth()
  }

  async stop(): Promise<void> {
    this.engine.stop()
    this.healthy = false
  }

  async setProject(path: string): Promise<void> {
    this.projectPath = path
  }

  info() {
    return { id: this.id, engine: 'lab', healthy: this.healthy, projectPath: this.projectPath }
  }

  supportsMcp(): boolean { return false }
  async registerMcpServer(_name: string, _config: McpServerConfig): Promise<boolean> { return false }
  async unregisterMcpServer(_name: string): Promise<void> {}

  onEvent(callback: (event: EventMessage) => void): () => void {
    this.eventCb = callback
    return () => { if (this.eventCb === callback) this.eventCb = undefined }
  }

  private emit(event: EventMessage): void { this.eventCb?.(event) }

  /* Sessions – mapped to the engine's store. Sub-agents are internal sessions
   * with a parent link, so they never surface in BOSS's thread list. */
  async sessionsList(): Promise<SessionInfo[]> {
    return this.engine.store.list().filter((session) => !this.engine.store.get(session.id)?.parentID)
  }

  async sessionCreate(title?: string, directory?: string): Promise<SessionInfo> {
    return this.engine.store.create(title, directory)
  }

  setSessionDirectory(id: string, directory: string): void {
    this.engine.store.setDirectory(id, directory)
  }

  async sessionDelete(id: string): Promise<void> {
    this.engine.disposeSession(id)
    this.engine.store.delete(id)
  }

  async sessionRename(id: string, title: string): Promise<SessionInfo> {
    return this.engine.store.rename(id, title)
  }

  async sessionGet(id: string): Promise<SessionInfo> {
    const record = this.engine.store.get(id)
    return { id: record.id, title: record.title, directory: record.directory, time: { created: record.createdAt, updated: record.updatedAt } }
  }

  async messagesList(sessionId: string, limit?: number): Promise<MessageWithParts[]> {
    return this.engine.store.messages(sessionId, limit)
  }

  /* Messages */
  async sendMessage(sessionId: string, parts: unknown[], options?: BackendMessageOptions): Promise<void> {
    await this.engine.sendMessage(sessionId, textFromParts(parts), {
      mode: options?.mode,
      model: options?.model?.modelID,
      context: options?.context
    })
    void this.refreshHealth()
  }

  async abort(sessionId: string): Promise<void> {
    this.engine.abort(sessionId)
  }

  /** Fold a steered message into a running session. The engine persists and
   *  queues it; the manager echoes it on its side. */
  async steer(sessionId: string, parts: unknown[]): Promise<void> {
    this.engine.steer(sessionId, textFromParts(parts))
  }

  /** Native slash commands: compact and help. Everything else returns a
   *  readable "unknown" so the renderer does not silently swallow it. */
  async runCommand(sessionId: string, command: string, _args: string, options?: BackendMessageOptions): Promise<MessageWithParts> {
    const id = randomUUID()
    let text: string
    if (command === 'compact') {
      await this.engine.compact(sessionId, options?.model?.modelID)
      text = 'Compacted the session history into a summary.'
    } else if (command === 'help') {
      text = 'Lab commands: /compact — summarize older turns and keep the newest messages.'
    } else {
      text = `Unknown command: /${command}`
    }
    return {
      info: { id, sessionID: sessionId, role: 'assistant', time: { created: Date.now() } },
      parts: [{ id: `${id}-text`, type: 'text', sessionID: sessionId, messageID: id, text }]
    }
  }

  /* Permissions */
  private requestPermission(
    sessionId: string,
    call: LabFunctionCall,
    args: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<'allow' | 'deny'> {
    const permissionId = randomUUID()
    const patterns = [String(args.path ?? '')].filter(Boolean)
    const shell = String(args.command ?? '')
    if (shell && permissionForTool(call.name) === 'shell') patterns.push(shell)
    return new Promise<'allow' | 'deny'>((resolve) => {
      const pending: PendingPermission = { submitSession: sessionId, toolName: call.name, resolve }
      const onAbort = (): void => this.settlePermission(permissionId, 'reject')
      pending.removeAbortListener = () => signal.removeEventListener('abort', onAbort)
      signal.addEventListener('abort', onAbort, { once: true })
      this.pendingPermissions.set(permissionId, pending)
      if (signal.aborted) {
        onAbort()
        return
      }
      this.emit({
        type: 'permission.asked',
        permission: {
          id: permissionId,
          sessionID: sessionId,
          permission: call.name,
          patterns,
          metadata: { arguments: args },
          tool: { callID: call.id },
          time: { created: Date.now() }
        }
      })
    })
  }

  private settlePermission(permissionId: string, response: 'once' | 'always' | 'reject'): void {
    const pending = this.pendingPermissions.get(permissionId)
    if (!pending) return
    this.pendingPermissions.delete(permissionId)
    pending.removeAbortListener?.()
    pending.resolve(response === 'reject' ? 'deny' : 'allow')
    this.emit({ type: 'permission.replied', sessionID: pending.submitSession, permissionID: permissionId, response })
  }

  async permissionRespond(sessionId: string, permissionId: string, response: 'once' | 'always' | 'reject'): Promise<void> {
    const pending = this.pendingPermissions.get(permissionId)
    if (!pending) throw new Error('Lab is no longer waiting for this approval.')
    if (pending.submitSession !== sessionId) throw new Error('This approval belongs to another thread.')
    if (response === 'always') {
      // "Always" outlives this request: future ask-mode calls for the same
      // tool on this thread run without prompting.
      this.engine.store.grantAlways(sessionId, pending.toolName)
    }
    this.settlePermission(permissionId, response)
  }

  /** Tell a running loop its permission mode changed. The engine re-reads the
   *  mode on every request, so the change applies immediately. */
  async permissionModeSet(sessionId: string, mode: BackendModeId): Promise<boolean> {
    this.engine.setPermissionMode(sessionId, mode)
    return true
  }

  /* Models */
  async modelsList(): Promise<ModelInfo[]> {
    const models = await this.engine.listModels()
    if (models.length > 0) this.healthy = true
    return models
  }

  async modelSelect(_providerId: string, modelId: string): Promise<void> {
    this.engine.selectModel(modelId)
  }

  async thinkingGet(): Promise<ThinkingLevel> { return { level: 'medium' } }
  async thinkingSet(_level: ThinkingLevel['level']): Promise<void> {}

  async todosGet(sessionId: string): Promise<Todo[]> {
    return this.engine.store.todosOf(sessionId)
  }

  async diffGet(sessionId: string, _messageId?: string): Promise<FileDiff[]> {
    const record = this.engine.store.get(sessionId)
    return this.engine.gitDiff(record.directory || this.projectPath || globalThis.process.cwd())
  }

  async fileTree(path?: string): Promise<FileNode[]> {
    return this.engine.fileTree(this.projectPath || globalThis.process.cwd(), path)
  }

  async fileContent(path: string): Promise<FileContent> {
    return this.engine.fileContentAt(this.projectPath || globalThis.process.cwd(), path)
  }
  async fork(sessionId: string): Promise<SessionInfo> { return { id: sessionId } }
  async revert(_sessionId: string, _messageId: string): Promise<void> {}
  async unrevert(_sessionId: string): Promise<void> {}
  async compact(sessionId: string, model?: { providerID: string; modelID: string }): Promise<void> {
    await this.engine.compact(sessionId, model?.modelID)
    this.emit({ type: 'session.compacted', sessionID: sessionId })
  }
}