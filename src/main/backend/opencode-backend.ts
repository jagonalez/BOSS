import type { OpenCodeServer } from '../opencode-server'
import type { ApiClient } from '../api-client'
import type { EventStream } from '../event-stream'
import type { Backend, McpServerConfig, ModelInfo, ThinkingLevel } from './backend'
import type { BackendMessageOptions } from '@shared/backend'
import type { SessionInfo, MessageWithParts, Todo, FileDiff, FileNode, FileContent, EventMessage } from '@shared/opencode'
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk'

/** Unwrap a generated client call.
 *
 *  The SDK is configured with throwOnError: false, so every call resolves to
 *  { data, error } instead of rejecting. That shape is what makes a failure
 *  legible — an OpenCode error body reaches us intact rather than as a status
 *  code — but every call site would otherwise repeat the same check. */
function unwrap<T>(result: { data?: T; error?: unknown }, what: string): T {
  if (result.error !== undefined) {
    const detail = typeof result.error === 'string' ? result.error : JSON.stringify(result.error)
    throw new Error(`OpenCode ${what} failed: ${detail}`)
  }
  if (result.data === undefined) throw new Error(`OpenCode ${what} returned no data.`)
  return result.data
}

export class OpenCodeBackend implements Backend {
  readonly id = 'opencode' as const
  private readonly server: OpenCodeServer
  private readonly api: ApiClient
  private readonly events: EventStream
  private eventCb?: (ev: EventMessage) => void
  private sessionDirectories = new Map<string, string>()
  private observedStatuses = new Map<string, 'busy' | 'retry'>()
  private submittedAt = new Map<string, number>()
  private statusTimer?: NodeJS.Timeout
  private reconcilingStatuses = false
  /** Built on first use, and dropped by start() so it picks up the port the
   *  server actually bound. Every OpenCode call goes through it. */
  private client?: OpencodeClient

  constructor(
    server: OpenCodeServer,
    api: ApiClient,
    events: EventStream
  ) {
    this.server = server
    this.api = api
    this.events = events
    // wire normalized events from EventStream -> EventMessage
    this.events.onEvent = (raw) => {
      try {
        const ev = JSON.parse(raw) as EventMessage
        this.observeStatus(ev)
        // EventMessage is the canonical shape; pass through
        this.eventCb?.(ev)
      } catch {
        this.eventCb?.({ type: 'unknown', raw })
      }
    }
  }

  /** The typed client, built on first use.
   *
   *  Not built in the constructor because baseUrl and the auth header only
   *  exist once the server is listening, and not required to come from start()
   *  because callers construct a backend and use it directly — the tests do,
   *  and so does any path that reaches a session before the server has been
   *  told to start. Building on demand keeps both working. */
  private sdk(): OpencodeClient {
    if (!this.client) {
      this.client = createOpencodeClient({
        baseUrl: this.server.baseUrl,
        headers: { Authorization: this.server.authHeader },
        // Return { data, error } rather than rejecting, so an OpenCode error
        // body survives to the call site instead of being flattened into a
        // throw.
        throwOnError: false
      })
    }
    return this.client
  }

  /** Per-request directory, matching what ApiClient sent as x-opencode-directory.
   *
   *  Falls back to the server's current project for the same reason ApiClient
   *  does: switching project no longer respawns the server, so a call with no
   *  explicit directory would otherwise keep hitting the project open at
   *  startup. */
  private directoryFor(sessionId?: string): string | undefined {
    const known = sessionId ? this.sessionDirectories.get(sessionId) : undefined
    return known || this.server.projectPath || undefined
  }

  async start(): Promise<void> {
    await this.server.start()
    // Drop any client built before the server had its final port, so the next
    // call rebuilds against the address it is actually listening on.
    this.client = undefined
    this.events.start()
    if (!this.statusTimer) {
      this.statusTimer = setInterval(() => void this.reconcileStatuses(), 2_000)
      this.statusTimer.unref()
    }
  }

  async stop(): Promise<void> {
    if (this.statusTimer) clearInterval(this.statusTimer)
    this.statusTimer = undefined
    this.events.stop()
    // What the server was running, which after this is nothing. Keeping these
    // left sessions marked busy against a server that had never heard of them.
    // sessionDirectories stays: which checkout a session belongs to is BOSS's
    // own knowledge, and a restarted server still needs telling.
    this.observedStatuses.clear()
    this.submittedAt.clear()
    this.client = undefined
    await this.server.stop()
  }

  async setProject(path: string): Promise<void> {
    await this.server.setProject(path)
  }

  info() {
    const s = this.server.info
    return {
      id: this.id,
      engine: 'opencode',
      version: s.version,
      healthy: s.healthy,
      projectPath: this.server.projectPath,
    }
  }

  supportsMcp(): boolean {
    return true
  }

  async registerMcpServer(name: string, config: McpServerConfig): Promise<boolean> {
    // Left on ApiClient: BOSS's McpServerConfig is its own shape, not the
    // generated McpAdd body, and forcing one into the other would assert a
    // match the types do not actually make.
    const res = await this.api.request({ method: 'POST', path: '/mcp', body: { name, config } })
    return res.status >= 200 && res.status < 300
  }

  async unregisterMcpServer(_name: string): Promise<void> {
    // opencode has no MCP remove endpoint; leave the server registered
  }

  onEvent(cb: (ev: EventMessage) => void): () => void {
    this.eventCb = cb
    return () => { this.eventCb = undefined }
  }

  /* Sessions – map to existing OpenCode HTTP API */
  async sessionsList(): Promise<SessionInfo[]> {
    const res = await this.sdk().session.list({ query: { directory: this.directoryFor() } })
    return unwrap(res, 'session list') as unknown as SessionInfo[]
  }

  async sessionCreate(title?: string, directory?: string): Promise<SessionInfo> {
    const res = await this.sdk().session.create({
      body: title ? { title } : {},
      query: { directory: directory || this.directoryFor() }
    })
    const session = unwrap(res, 'session create') as unknown as SessionInfo
    if (directory || session.directory) this.setSessionDirectory(session.id, directory ?? session.directory!)
    return session
  }

  setSessionDirectory(id: string, directory: string): void {
    this.sessionDirectories.set(id, directory)
  }

  async sessionDelete(id: string): Promise<void> {
    const res = await this.sdk().session.delete({
      path: { id },
      query: { directory: this.directoryFor(id) }
    })
    unwrap(res, 'session delete')
    this.sessionDirectories.delete(id)
    this.observedStatuses.delete(id)
    this.submittedAt.delete(id)
  }

  async sessionRename(id: string, title: string): Promise<SessionInfo> {
    const res = await this.sdk().session.update({
      path: { id },
      body: { title },
      query: { directory: this.directoryFor(id) }
    })
    return unwrap(res, 'session rename') as unknown as SessionInfo
  }

  async sessionGet(id: string): Promise<SessionInfo> {
    const res = await this.sdk().session.get({
      path: { id },
      query: { directory: this.directoryFor(id) }
    })
    return unwrap(res, 'session get') as unknown as SessionInfo
  }

  /* Messages */
  async messagesList(sessionId: string, limit?: number): Promise<MessageWithParts[]> {
    const res = await this.sdk().session.messages({
      path: { id: sessionId },
      query: { directory: this.directoryFor(sessionId), ...(limit ? { limit } : {}) }
    })
    return unwrap(res, 'message list') as unknown as MessageWithParts[]
  }

  async sendMessage(sessionId: string, parts: unknown[], opts?: BackendMessageOptions): Promise<void> {
    // context is BOSS's own field and not an OpenCode parameter, so it is
    // dropped here. OpenCode is told the directory per session already, and
    // inventing a prompt field to carry the rest is worse than leaving it.
    const { context: _context, ...rest } = opts ?? {}
    const res = await this.sdk().session.promptAsync({
      path: { id: sessionId },
      body: { parts: parts as never, ...rest },
      query: { directory: this.directoryFor(sessionId) }
    })
    unwrap(res, 'prompt')
    // The manager already exposes an optimistic busy state. Mirroring it here
    // lets status reconciliation clear that state if the corresponding idle
    // event is missed. Give OpenCode a short window to publish its busy state
    // before treating an absent status entry as idle.
    this.observedStatuses.set(sessionId, 'busy')
    this.submittedAt.set(sessionId, Date.now())
  }

  async abort(sessionId: string): Promise<void> {
    const res = await this.sdk().session.abort({
      path: { id: sessionId },
      query: { directory: this.directoryFor(sessionId) }
    })
    unwrap(res, 'abort')
  }

  private observeStatus(event: EventMessage): void {
    const value = event as EventMessage & { properties?: { sessionID?: string; status?: { type?: string } } }
    const sessionId = value.properties?.sessionID ?? ('sessionID' in value ? value.sessionID : undefined)
    if (!sessionId) return
    const status = value.properties?.status?.type ?? (value.type === 'session.status' ? value.status.type : undefined)
    if (status === 'busy' || status === 'retry') {
      this.observedStatuses.set(sessionId, status)
      return
    }
    if (value.type === 'session.idle' || status === 'idle' || value.type === 'session.error') {
      this.observedStatuses.delete(sessionId)
      this.submittedAt.delete(sessionId)
    }
  }

  private async reconcileStatuses(): Promise<void> {
    if (this.reconcilingStatuses || this.sessionDirectories.size === 0) return
    this.reconcilingStatuses = true
    try {
      const directories = new Set(this.sessionDirectories.values())
      for (const directory of directories) {
        const response = await this.sdk().session.status({ query: { directory } })
        // Reconciliation runs on a timer against a server that may be
        // restarting, so a failed poll is skipped rather than thrown: the next
        // tick retries, and throwing here would kill the interval.
        if (response.error !== undefined || !response.data) continue
        const statuses = response.data
        for (const [sessionId, knownDirectory] of this.sessionDirectories) {
          if (knownDirectory !== directory) continue
          const status = statuses[sessionId]?.type
          const previous = this.observedStatuses.get(sessionId)
          if (status === 'busy' || status === 'retry') {
            if (previous !== status) {
              this.observedStatuses.set(sessionId, status)
              this.eventCb?.({ type: 'session.status', sessionID: sessionId, status: { type: status } })
            }
            continue
          }
          if (!previous) continue
          if (Date.now() - (this.submittedAt.get(sessionId) ?? 0) < 3_000) continue
          this.observedStatuses.delete(sessionId)
          this.submittedAt.delete(sessionId)
          this.eventCb?.({ type: 'session.idle', sessionID: sessionId })
        }
      }
    } finally {
      this.reconcilingStatuses = false
    }
  }

  /* Models */
  async modelsList(): Promise<ModelInfo[]> {
    const res = await this.sdk().config.providers({ query: { directory: this.directoryFor() } })
    // adapt { all: Provider[] } -> ModelInfo[]
    const body = unwrap(res, 'provider list') as { all?: Array<{ id: string; models?: Record<string, { id: string; name?: string }> | Array<{ id: string; name?: string }> }> }
    return (body.all ?? []).flatMap((p) => {
      // The generated type models `models` as a record keyed by model id, while
      // the hand-written code read it as an array. Accept both so this keeps
      // working across the shape it actually returns.
      const models = Array.isArray(p.models) ? p.models : Object.values(p.models ?? {})
      return models.map((m) => ({ id: m.id, name: m.name, provider: p.id }))
    })
  }

  async modelSelect(_providerId: string, _modelId: string): Promise<void> {
    // opencode has no global select; per-message. Stub.
  }

  /* Thinking */
  async thinkingGet(): Promise<ThinkingLevel> { return { level: 'medium' } }
  async thinkingSet(_level: ThinkingLevel['level']): Promise<void> { /* opencode config */ }

  /* Todos / Permissions */
  async todosGet(sessionId: string): Promise<Todo[]> {
    const res = await this.sdk().session.todo({
      path: { id: sessionId },
      query: { directory: this.directoryFor(sessionId) }
    })
    return unwrap(res, 'todo list') as unknown as Todo[]
  }

  async permissionRespond(sessionId: string, permissionId: string, response: 'once'|'always'|'reject'): Promise<void> {
    const res = await this.sdk().postSessionIdPermissionsPermissionId({
      path: { id: sessionId, permissionID: permissionId },
      body: { response },
      query: { directory: this.directoryFor(sessionId) }
    })
    unwrap(res, 'permission response')
  }

  /* Files / Diff */
  async diffGet(sessionId: string, messageId?: string): Promise<FileDiff[]> {
    const res = await this.sdk().session.diff({
      path: { id: sessionId },
      query: { directory: this.directoryFor(sessionId), ...(messageId ? { messageID: messageId } : {}) }
    })
    return unwrap(res, 'diff') as unknown as FileDiff[]
  }

  async fileTree(path?: string): Promise<FileNode[]> {
    const res = await this.sdk().file.list({
      query: { path: path ?? '', directory: this.directoryFor() }
    })
    return unwrap(res, 'file list') as unknown as FileNode[]
  }

  async fileContent(path: string): Promise<FileContent> {
    const res = await this.sdk().file.read({
      query: { path, directory: this.directoryFor() }
    })
    return unwrap(res, 'file read') as unknown as FileContent
  }

  /* Fork / Revert */
  async fork(sessionId: string, messageId?: string): Promise<SessionInfo> {
    const res = await this.sdk().session.fork({
      path: { id: sessionId },
      body: messageId ? { messageID: messageId } : {},
      query: { directory: this.directoryFor(sessionId) }
    })
    return unwrap(res, 'fork') as unknown as SessionInfo
  }

  async revert(sessionId: string, messageId: string): Promise<void> {
    const res = await this.sdk().session.revert({
      path: { id: sessionId },
      body: { messageID: messageId },
      query: { directory: this.directoryFor(sessionId) }
    })
    unwrap(res, 'revert')
  }

  async unrevert(sessionId: string): Promise<void> {
    const res = await this.sdk().session.unrevert({
      path: { id: sessionId },
      query: { directory: this.directoryFor(sessionId) }
    })
    unwrap(res, 'unrevert')
  }

  async runCommand(sessionId: string, command: string, args: string, opts?: BackendMessageOptions): Promise<MessageWithParts> {
    // This endpoint takes model as a "providerID/modelID" string, unlike
    // prompt, which takes the pair as an object. BOSS carries the pair, so it
    // is joined here. The untyped client sent the object straight through and
    // OpenCode ignored it, so a slash command silently ran on the default
    // model rather than the one the thread had chosen.
    const model = opts?.model ? `${opts.model.providerID}/${opts.model.modelID}` : undefined
    const res = await this.sdk().session.command({
      path: { id: sessionId },
      body: { command, arguments: args, agent: opts?.agent, model },
      query: { directory: this.directoryFor(sessionId) }
    })
    return unwrap(res, 'command') as unknown as MessageWithParts
  }

  async compact(sessionId: string, model?: { providerID: string; modelID: string }): Promise<void> {
    if (!model) throw new Error('OpenCode compaction requires a model selection.')
    const res = await this.sdk().session.summarize({
      path: { id: sessionId },
      body: model,
      query: { directory: this.directoryFor(sessionId) }
    })
    unwrap(res, 'compact')
  }
}
