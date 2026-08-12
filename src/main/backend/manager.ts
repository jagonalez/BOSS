import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Backend } from './backend'
import type {
  BackendDescriptor,
  BackendId,
  BackendRequest,
  BackendCapabilities,
  BackendMessageOptions,
  BackendModelPreference,
  QueuedFollowUp,
  QueuedFollowUpAttachment,
  ThreadCreationScope
} from '@shared/backend'
import type { EventMessage, MessageWithParts, Part, SessionInfo } from '@shared/opencode'
import type { ThreadBus } from '../thread-bus'
import type { ThreadBusConnection, ThreadBusSnapshot, ThreadBusThread } from '@shared/thread-bus'
import { projectScope, type ProjectScope } from '../project-identity'
import type { WorktreeInfo, WorktreeSettings } from '@shared/worktree'
import type { WorktreeManager } from '../worktree-manager'
import type { BackendAuth } from '../backend-auth'
import type { TranscriptStore } from '../transcript-store'

interface ThreadBinding {
  id: string
  backendId: BackendId
  nativeSessionId: string
  nativeSessionOwnership: 'ralf' | 'imported'
  projectId: string
  projectPath: string
  executionPath: string
  title?: string
  createdAt: number
  updatedAt: number
  parentID?: string
  lineage?: SessionInfo['lineage']
  worktree?: WorktreeInfo
  followUps?: QueuedFollowUp[]
}

type LegacyThreadBinding = Omit<ThreadBinding, 'nativeSessionOwnership' | 'projectId' | 'executionPath'>

interface LegacyBackendState {
  version: 1
  threads: LegacyThreadBinding[]
}

interface PreviousBackendState {
  version: 2
  legacyOpenCodeImportComplete: boolean
  threads: ThreadBinding[]
}

interface StoredBackendState {
  version: 3
  threads: ThreadBinding[]
}

interface BackendDefinition {
  label: string
  description: string
  command?: string
  capabilities: BackendCapabilities
  modes: BackendDescriptor['modes']
}

const DEFINITIONS: Record<BackendId, BackendDefinition> = {
  opencode: {
    label: 'OpenCode',
    description: 'OpenCode server with native sessions, permissions, tools, and providers.',
    capabilities: { streaming: true, models: true, permissions: true, nativeFork: true, steering: 'stop-and-redirect', branching: 'message', images: true, mcp: true, interactiveQuestions: true },
    modes: [
      { id: 'ask', label: 'Ask', description: 'prompt before sensitive actions' },
      { id: 'auto', label: 'Auto', description: 'approve supported actions automatically' },
      { id: 'plan', label: 'Plan', description: 'read-only planning agent' }
    ]
  },
  pi: {
    label: 'Pi',
    description: 'Pi coding agent over its native JSONL RPC protocol.',
    command: 'pi',
    capabilities: { streaming: true, models: true, permissions: false, nativeFork: true, steering: 'native', branching: 'message', images: true, mcp: false, interactiveQuestions: false },
    modes: [{ id: 'auto', label: 'Approved', description: 'Pi RPC runs with its approved tool policy' }]
  },
  codex: {
    label: 'Codex',
    description: 'Codex CLI through the supported app-server JSON-RPC protocol.',
    command: 'codex',
    capabilities: { streaming: true, models: true, permissions: true, nativeFork: true, steering: 'native', branching: 'thread', images: true, mcp: false, interactiveQuestions: false },
    modes: [
      { id: 'ask', label: 'Ask', description: 'request approval when Codex needs to leave its sandbox' },
      { id: 'auto', label: 'Auto', description: 'run inside the workspace sandbox without approval prompts' },
      { id: 'plan', label: 'Plan', description: 'read-only filesystem sandbox' }
    ]
  },
  claude: {
    label: 'Claude Code',
    description: 'Claude Code through its streaming non-interactive protocol.',
    command: 'claude',
    capabilities: { streaming: true, models: true, permissions: false, nativeFork: false, steering: 'stop-and-redirect', branching: 'context-copy', images: false, mcp: false, interactiveQuestions: false },
    modes: [
      { id: 'ask', label: 'Ask', description: 'use Claude default permissions; unavailable approvals stop the run' },
      { id: 'accept-edits', label: 'Edit automatically', description: 'approve edits and common filesystem operations' },
      { id: 'plan', label: 'Plan', description: 'read-only planning mode' }
    ]
  }
}

function stateFile(): string {
  return join(app.getPath('userData'), 'backend-threads.json')
}

function now(): number {
  return Date.now()
}

function probeVersion(command: string): { available: boolean; version?: string; reason?: string } {
  try {
    const output = execFileSync(command, ['--version'], {
      encoding: 'utf8',
      timeout: 2500,
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
    return { available: true, version: output.split('\n')[0] }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return {
      available: false,
      reason: code === 'ENOENT' ? `${command} is not installed or is not on PATH.` : `${command} could not be started.`
    }
  }
}

function textFromParts(parts: unknown[]): string {
  return parts
    .map((part) => {
      if (!part || typeof part !== 'object') return ''
      const item = part as { type?: string; text?: string; filename?: string; mime?: string }
      if (item.type === 'text') return item.text ?? ''
      if (item.type === 'file') return `[Attached file: ${item.filename ?? item.mime ?? 'file'}]`
      return item.text ?? ''
    })
    .filter(Boolean)
    .join('\n')
}

function transcript(messages: MessageWithParts[], maxChars = 48_000): string {
  const rendered = messages.slice(-30).map((message) => {
    const body = message.parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .filter(Boolean)
      .join('\n')
    return `${message.info.role === 'user' ? 'USER' : 'ASSISTANT'}:\n${body}`
  }).filter((item) => !item.endsWith(':\n'))
  let result = rendered.join('\n\n')
  if (result.length > maxChars) result = `[…earlier context omitted…]\n\n${result.slice(-maxChars)}`
  return result
}

export class BackendManager {
  private projectPath = ''
  private readonly bindings = new Map<string, ThreadBinding>()
  private readonly started = new Set<BackendId>()
  private readonly starting = new Map<BackendId, Promise<Backend>>()
  private readonly unsubscribers = new Map<BackendId, () => void>()
  private readonly busyThreads = new Set<string>()
  private readonly followUpDeliveries = new Set<string>()
  private threadBus?: ThreadBus
  private readonly eventCbs = new Set<(event: Record<string, unknown>) => void>()
  private automations?: { handle(request: BackendRequest): Promise<unknown> }
  private mcpHub?: { handle(request: BackendRequest): Promise<unknown> }
  private defaultModels?: Partial<Record<BackendId, BackendModelPreference>>
  private loaded = false
  private worktreeCleanupTimer?: NodeJS.Timeout

  constructor(
    private readonly backends: Record<BackendId, Backend>,
    private readonly worktrees?: WorktreeManager,
    private readonly backendAuth?: BackendAuth,
    private readonly transcripts?: TranscriptStore
  ) {}

  attachThreadBus(threadBus: ThreadBus): void {
    this.threadBus = threadBus
    for (const backend of Object.values(this.backends)) {
      backend.setThreadBusHandler?.((call) => threadBus.agentCall(backend.id, call.nativeThreadId, call.tool, call.arguments))
    }
  }

  configureThreadBus(connection: ThreadBusConnection): void {
    for (const backend of Object.values(this.backends)) backend.configureThreadBus?.(connection)
  }

  get currentProject(): string {
    return this.projectPath
  }

  private get currentScope(): ProjectScope {
    return projectScope(this.projectPath)
  }

  private get globalScope(): ProjectScope {
    const executionPath = join(app.getPath('userData'), 'chats')
    mkdirSync(executionPath, { recursive: true })
    return { projectId: 'global', projectPath: '', executionPath }
  }

  onEvent(callback: (event: Record<string, unknown>) => void): () => void {
    this.eventCbs.add(callback)
    return () => {
      this.eventCbs.delete(callback)
    }
  }

  emit(event: Record<string, unknown>): void {
    for (const callback of this.eventCbs) callback(event)
  }

  scopeFor(projectPath: string): ProjectScope {
    return projectPath ? projectScope(projectPath) : this.globalScope
  }

  private defaultModelsFile(): string {
    return join(app.getPath('userData'), 'backend-defaults.json')
  }

  private loadDefaultModels(): void {
    if (this.defaultModels) return
    try {
      this.defaultModels = JSON.parse(readFileSync(this.defaultModelsFile(), 'utf8')) as Partial<Record<BackendId, BackendModelPreference>>
    } catch {
      this.defaultModels = {}
    }
  }

  setDefaultModels(defaults: Partial<Record<BackendId, BackendModelPreference>>): void {
    this.defaultModels = { ...defaults }
    try {
      writeFileSync(this.defaultModelsFile(), JSON.stringify(this.defaultModels, null, 2))
    } catch {
      /* Defaults keep working in memory if persistence is unavailable. */
    }
  }

  defaultModel(backendId: BackendId): BackendModelPreference | undefined {
    this.loadDefaultModels()
    const preference = this.defaultModels?.[backendId]
    return preference ? { ...preference } : undefined
  }

  isThreadBusy(threadId: string): boolean {
    return this.busyThreads.has(threadId)
  }

  createScopedThread(
    backendId: BackendId,
    scope: ProjectScope,
    title: string,
    worktree?: WorktreeInfo
  ): Promise<SessionInfo> {
    return this.sessionCreateInScope(backendId, scope, title, undefined, worktree)
  }

  attachAutomations(automations: { handle(request: BackendRequest): Promise<unknown> }): void {
    this.automations = automations
  }

  attachMcpHub(mcpHub: { handle(request: BackendRequest): Promise<unknown> }): void {
    this.mcpHub = mcpHub
  }

  async start(projectPath?: string): Promise<void> {
    this.load()
    if (projectPath) this.projectPath = projectPath
    await this.ensureStarted('opencode')
    await this.threadBus?.resume()
    for (const binding of this.bindings.values()) {
      if (binding.followUps?.length) void this.deliverNextFollowUp(binding.id)
    }
    await this.cleanupWorktrees()
    this.worktreeCleanupTimer = setInterval(() => void this.cleanupWorktrees(), 6 * 60 * 60 * 1_000)
    this.worktreeCleanupTimer.unref()
  }

  async stop(): Promise<void> {
    await Promise.all((Object.keys(this.backends) as BackendId[]).map((id) => this.backends[id].stop().catch(() => {})))
    this.started.clear()
    for (const off of this.unsubscribers.values()) off()
    this.unsubscribers.clear()
    await this.threadBus?.stop()
    if (this.worktreeCleanupTimer) clearInterval(this.worktreeCleanupTimer)
    this.worktreeCleanupTimer = undefined
    this.transcripts?.close()
  }

  async setProject(path: string): Promise<void> {
    this.projectPath = path
    for (const id of this.started) await this.backends[id].setProject(path)
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed = JSON.parse(readFileSync(stateFile(), 'utf8')) as StoredBackendState | PreviousBackendState | LegacyBackendState
      if ((parsed.version === 2 || parsed.version === 3) && Array.isArray(parsed.threads)) {
        for (const binding of parsed.threads) this.bindings.set(binding.id, binding)
      } else if (parsed.version === 1 && Array.isArray(parsed.threads)) {
        for (const legacy of parsed.threads) {
          const scope = projectScope(legacy.projectPath)
          const binding: ThreadBinding = {
            ...legacy,
            nativeSessionOwnership: legacy.backendId === 'opencode' ? 'imported' : 'ralf',
            projectId: scope.projectId,
            projectPath: scope.projectPath,
            executionPath: scope.executionPath
          }
          this.bindings.set(binding.id, binding)
        }
        this.save()
      }
    } catch {
      /* Preserve pre-R.A.L.F. OpenCode sessions once on first launch or migration. */
      /* First R.A.L.F. launch starts with no thread bindings. */
    }
    this.migrateLegacyCodexParts()
  }

  private migrateLegacyCodexParts(): void {
    if (!this.transcripts || this.transcripts.metadata('migration.codex-live-parts.v1') === 'complete') return
    try {
      const parsed = JSON.parse(readFileSync(join(app.getPath('userData'), 'codex-live-parts.json'), 'utf8')) as {
        version?: number
        threads?: Record<string, Record<string, Part[]>>
      }
      if (parsed.version === 1 && parsed.threads) {
        for (const [nativeSessionId, messages] of Object.entries(parsed.threads)) {
          const binding = this.bindingForNative('codex', nativeSessionId)
          if (!binding) continue
          for (const parts of Object.values(messages)) {
            for (const part of parts) this.transcripts.recordPart(this.transcriptSource(binding), part)
          }
        }
        this.transcripts.flush()
      }
    } catch {
      /* No legacy cache is the normal case on a fresh install. */
    }
    this.transcripts.setMetadata('migration.codex-live-parts.v1', 'complete')
  }

  private save(): void {
    const state: StoredBackendState = {
      version: 3,
      threads: [...this.bindings.values()]
    }
    try {
      writeFileSync(stateFile(), JSON.stringify(state, null, 2))
    } catch {
      /* Threads keep working in memory if persistence is unavailable. */
    }
  }

  private async ensureStarted(id: BackendId): Promise<Backend> {
    const backend = this.backends[id]
    if (!backend) throw new Error(`Unknown backend: ${id}`)
    if (!this.unsubscribers.has(id)) {
      this.unsubscribers.set(id, backend.onEvent((event) => this.forwardEvent(id, event)))
    }
    if (this.started.has(id)) return backend
    const pending = this.starting.get(id)
    if (pending) return pending
    const start = (async () => {
      try {
        await backend.start()
        if (this.projectPath) await backend.setProject(this.projectPath)
        this.started.add(id)
        return backend
      } catch (error) {
        await backend.stop().catch(() => {})
        throw error
      }
    })()
    this.starting.set(id, start)
    try {
      return await start
    } finally {
      this.starting.delete(id)
    }
  }

  private binding(threadId: string): ThreadBinding {
    const binding = this.bindings.get(threadId)
    if (!binding) throw new Error(`R.A.L.F. thread not found: ${threadId}`)
    this.backends[binding.backendId].setSessionDirectory?.(binding.nativeSessionId, binding.executionPath)
    if (binding.worktree?.status === 'active') void this.worktrees?.touch(binding.worktree.id)
    return binding
  }

  private bindingForNative(backendId: BackendId, nativeSessionId?: string): ThreadBinding | undefined {
    if (!nativeSessionId) return undefined
    return [...this.bindings.values()].find(
      (binding) => binding.backendId === backendId && binding.nativeSessionId === nativeSessionId
    )
  }

  private transcriptSource(binding: ThreadBinding) {
    return {
      threadId: binding.id,
      backendId: binding.backendId,
      nativeSessionId: binding.nativeSessionId
    }
  }

  private session(binding: ThreadBinding, native?: SessionInfo): SessionInfo {
    return {
      ...native,
      id: binding.id,
      backendId: binding.backendId,
      nativeSessionId: binding.nativeSessionId,
      nativeSessionOwnership: binding.nativeSessionOwnership,
      projectId: binding.projectId,
      projectPath: binding.projectPath,
      executionPath: binding.executionPath,
      title: binding.title ?? native?.title,
      directory: binding.executionPath || native?.directory,
      path: binding.executionPath || native?.path,
      parentID: binding.parentID,
      lineage: binding.lineage,
      worktree: binding.worktree,
      time: native?.time ?? { created: binding.createdAt, updated: binding.updatedAt }
    }
  }

  private registerNative(
    backendId: BackendId,
    native: SessionInfo,
    nativeSessionOwnership: ThreadBinding['nativeSessionOwnership'],
    lineage?: SessionInfo['lineage']
  ): ThreadBinding {
    const existing = this.bindingForNative(backendId, native.id)
    if (existing) {
      existing.title = native.title ?? existing.title
      existing.updatedAt = native.time?.updated ?? now()
      if (native.directory) {
        const scope = projectScope(native.directory)
        existing.projectId = scope.projectId
        existing.projectPath = scope.projectPath
        existing.executionPath = scope.executionPath
      }
      this.bindings.set(existing.id, existing)
      return existing
    }
    const executionPath = native.directory || this.projectPath
    const scope = projectScope(executionPath)
    const binding: ThreadBinding = {
      id: randomUUID(),
      backendId,
      nativeSessionId: native.id,
      nativeSessionOwnership,
      projectId: scope.projectId,
      projectPath: scope.projectPath,
      executionPath: scope.executionPath,
      title: native.title,
      createdAt: native.time?.created ?? now(),
      updatedAt: native.time?.updated ?? now(),
      lineage
    }
    this.bindings.set(binding.id, binding)
    return binding
  }

  private normalizeEvent(event: EventMessage | Record<string, unknown>): Record<string, unknown> {
    const value = event as Record<string, unknown>
    if (value.properties && typeof value.properties === 'object') return value
    switch (value.type) {
      case 'message.updated': return { type: value.type, properties: { info: value.message } }
      case 'message.part.updated':
      case 'message.part.created': return { type: value.type, properties: { part: value.part } }
      case 'session.updated':
      case 'session.created':
      case 'session.deleted': return { type: value.type, properties: { info: value.session } }
      case 'session.todo.updated': return { type: 'todo.updated', properties: { sessionID: value.sessionID, todos: value.todos } }
      case 'permission.asked':
      case 'permission.updated': return { type: value.type, properties: value.permission ?? {} }
      case 'permission.replied': return { type: value.type, properties: { sessionID: value.sessionID, permissionID: value.permissionID, response: value.response } }
      case 'session.status': return { type: value.type, properties: { sessionID: value.sessionID, status: value.status } }
      case 'session.idle':
      case 'session.compacted': return { type: value.type, properties: { sessionID: value.sessionID } }
      case 'session.error': return { type: value.type, properties: { sessionID: value.sessionID, error: value.error } }
      default: return value
    }
  }

  private forwardEvent(backendId: BackendId, raw: EventMessage | Record<string, unknown>): void {
    const event = this.normalizeEvent(raw)
    const properties = { ...((event.properties as Record<string, unknown> | undefined) ?? {}) }
    const eventType = String(event.type ?? '')
    const info = (properties.info ?? properties.session) as SessionInfo | undefined
    const sessionInfo = eventType === 'session.updated' || eventType === 'session.created' || eventType === 'session.deleted'
      ? info
      : undefined
    const messageInfo = eventType === 'message.updated'
      ? info as unknown as { sessionID?: string }
      : undefined
    const part = properties.part as { sessionID?: string; messageID?: string } | undefined
    const nativeId = (properties.sessionID as string | undefined) ?? sessionInfo?.id ?? messageInfo?.sessionID ?? part?.sessionID
    const binding = this.bindingForNative(backendId, nativeId)
    if (!binding && nativeId) return
    if (binding) {
      if (sessionInfo) {
        properties.info = this.session(binding, sessionInfo)
        binding.title = sessionInfo.title ?? binding.title
        binding.updatedAt = sessionInfo.time?.updated ?? now()
        this.save()
      }
      if (properties.sessionID) properties.sessionID = binding.id
      if (part) properties.part = { ...part, sessionID: binding.id }
      if (messageInfo?.sessionID) properties.info = { ...messageInfo, sessionID: binding.id }
      if (eventType === 'message.updated' && properties.info) {
        this.transcripts?.recordMessage(
          this.transcriptSource(binding),
          properties.info as MessageWithParts['info']
        )
      } else if ((eventType === 'message.part.updated' || eventType === 'message.part.created') && properties.part) {
        this.transcripts?.recordPart(
          this.transcriptSource(binding),
          properties.part as MessageWithParts['parts'][number]
        )
      }
      if (eventType === 'session.status') {
        const status = (properties.status as { type?: string } | undefined)?.type
        if (status === 'busy' || status === 'retry') {
          if (!this.busyThreads.has(binding.id)) {
            this.transcripts?.beginRun(this.transcriptSource(binding))
          }
          this.busyThreads.add(binding.id)
        } else {
          this.transcripts?.finishRun(this.transcriptSource(binding), 'completed')
          this.busyThreads.delete(binding.id)
        }
      } else if (eventType === 'session.idle') {
        this.transcripts?.finishRun(this.transcriptSource(binding), 'completed')
        this.busyThreads.delete(binding.id)
        void this.threadBus?.flush(binding.id)
        void this.deliverNextFollowUp(binding.id)
      } else if (eventType === 'session.error') {
        this.transcripts?.finishRun(this.transcriptSource(binding), 'error')
        this.busyThreads.delete(binding.id)
      }
    }
    this.emit({ ...event, properties, backendId })
  }

  async descriptors(): Promise<BackendDescriptor[]> {
    return (Object.keys(DEFINITIONS) as BackendId[]).map((id) => {
      const definition = DEFINITIONS[id]
      const probe = definition.command ? probeVersion(definition.command) : { available: true }
      const info = this.backends[id].info()
      return {
        id,
        label: definition.label,
        description: definition.description,
        command: definition.command,
        available: probe.available,
        healthy: this.started.has(id) ? info.healthy : probe.available,
        version: info.version || probe.version,
        unavailableReason: probe.reason,
        capabilities: definition.capabilities,
        modes: definition.modes
      }
    })
  }

  async sessionsList(): Promise<SessionInfo[]> {
    this.load()
    const openCode = await this.ensureStarted('opencode')
    const nativeSessions = await openCode.sessionsList().catch(() => [])
    const currentProjectId = this.currentScope.projectId

    const current = [...this.bindings.values()].filter((binding) => {
      if (!this.projectPath) return true
      return binding.projectId === currentProjectId || binding.projectId === 'global'
    })
    return current
      .map((binding) => {
        const native = binding.backendId === 'opencode'
          ? nativeSessions.find((session) => session.id === binding.nativeSessionId)
          : undefined
        return this.session(binding, native)
      })
      .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
  }

  async sessionCreate(
    backendId: BackendId,
    title?: string,
    lineage?: SessionInfo['lineage'],
    creationScope: ThreadCreationScope = 'current'
  ): Promise<SessionInfo> {
    const scope = creationScope === 'global' ? this.globalScope : this.currentScope
    return this.sessionCreateInScope(backendId, scope, title, lineage)
  }

  private async sessionCreateInScope(
    backendId: BackendId,
    scope: ProjectScope,
    title?: string,
    lineage?: SessionInfo['lineage'],
    worktree?: WorktreeInfo
  ): Promise<SessionInfo> {
    const backend = await this.ensureStarted(backendId)
    const native = await backend.sessionCreate(title, scope.executionPath || undefined)
    const binding = this.registerNative(backendId, native, 'ralf', lineage)
    binding.title = title ?? native.title
    binding.projectId = scope.projectId
    binding.projectPath = scope.projectPath
    binding.executionPath = scope.executionPath
    binding.worktree = worktree
    this.bindings.set(binding.id, binding)
    this.save()
    const session = this.session(binding, native)
    this.emit({ type: 'session.created', properties: { info: session }, backendId })
    return session
  }

  async sessionGet(threadId: string): Promise<SessionInfo> {
    const binding = this.binding(threadId)
    const backend = await this.ensureStarted(binding.backendId)
    const native = await backend.sessionGet(binding.nativeSessionId).catch(() => ({ id: binding.nativeSessionId }))
    return this.session(binding, native)
  }

  async sessionDelete(threadId: string): Promise<void> {
    const binding = this.binding(threadId)
    if (binding.nativeSessionOwnership === 'ralf') {
      const backend = await this.ensureStarted(binding.backendId)
      await backend.sessionDelete(binding.nativeSessionId)
    }
    this.transcripts?.deleteThread(threadId)
    this.bindings.delete(threadId)
    this.save()
    this.emit({ type: 'session.deleted', properties: { info: this.session(binding) }, backendId: binding.backendId })
  }

  async sessionRename(threadId: string, title: string): Promise<SessionInfo> {
    const binding = this.binding(threadId)
    const backend = await this.ensureStarted(binding.backendId)
    const native = await backend.sessionRename(binding.nativeSessionId, title).catch(() => ({ id: binding.nativeSessionId, title }))
    binding.title = title
    binding.updatedAt = now()
    this.save()
    const session = this.session(binding, native)
    this.emit({ type: 'session.updated', properties: { info: session }, backendId: binding.backendId })
    return session
  }

  async messagesList(threadId: string, limit?: number): Promise<MessageWithParts[]> {
    const binding = this.binding(threadId)
    let messages: MessageWithParts[]
    try {
      const backend = await this.ensureStarted(binding.backendId)
      messages = await backend.messagesList(binding.nativeSessionId)
    } catch (error) {
      if (this.transcripts?.hasMessages(threadId)) return this.transcripts.messages(threadId, limit)
      throw error
    }
    const normalized = messages.map((message) => ({
      info: { ...message.info, sessionID: threadId },
      parts: message.parts.map((part) => ({ ...part, sessionID: threadId }))
    }))
    if (!this.transcripts) return limit ? normalized.slice(-limit) : normalized
    this.transcripts.reconcile(this.transcriptSource(binding), normalized, {
      pruneMissingMessages: !this.busyThreads.has(threadId)
    })
    return this.transcripts.messages(threadId, limit)
  }

  async sendMessage(threadId: string, parts: unknown[], options?: BackendMessageOptions): Promise<void> {
    const binding = this.binding(threadId)
    if (binding.worktree?.status === 'removed') {
      throw new Error('This thread\'s worktree was cleaned up. Fork it into a new worktree before continuing.')
    }
    const backend = await this.ensureStarted(binding.backendId)
    binding.updatedAt = now()
    this.save()
    this.transcripts?.beginRun(this.transcriptSource(binding))
    this.busyThreads.add(threadId)
    try {
      await backend.sendMessage(binding.nativeSessionId, parts, options)
    } catch (error) {
      this.transcripts?.finishRun(this.transcriptSource(binding), 'error')
      this.busyThreads.delete(threadId)
      throw error
    }
  }

  private emitFollowUps(binding: ThreadBinding): void {
    this.emit({
      type: 'thread.followups.updated',
      properties: { threadId: binding.id, followUps: binding.followUps ?? [] },
      backendId: binding.backendId
    })
  }

  private followUpParts(item: QueuedFollowUp): unknown[] {
    return [
      ...item.attachments.map((attachment) => ({
        type: 'file',
        mime: attachment.mime,
        filename: attachment.name,
        url: attachment.dataUrl
      })),
      ...(item.text.trim() ? [{ type: 'text', text: item.text }] : [])
    ]
  }

  followUps(threadId: string): QueuedFollowUp[] {
    return [...(this.binding(threadId).followUps ?? [])]
  }

  async addFollowUp(
    threadId: string,
    text: string,
    attachments: QueuedFollowUpAttachment[] = [],
    options?: BackendMessageOptions
  ): Promise<QueuedFollowUp[]> {
    if (!text.trim() && attachments.length === 0) throw new Error('A follow-up message is required.')
    const binding = this.binding(threadId)
    const item: QueuedFollowUp = {
      id: randomUUID(),
      threadId,
      text,
      attachments,
      options,
      createdAt: now()
    }
    binding.followUps = [...(binding.followUps ?? []), item]
    this.save()
    this.emitFollowUps(binding)
    if (!this.busyThreads.has(threadId)) void this.deliverNextFollowUp(threadId)
    return [...binding.followUps]
  }

  updateFollowUp(threadId: string, followUpId: string, text: string): QueuedFollowUp[] {
    const binding = this.binding(threadId)
    const item = binding.followUps?.find((followUp) => followUp.id === followUpId)
    if (!item) throw new Error('Queued follow-up not found.')
    if (!text.trim() && item.attachments.length === 0) throw new Error('A follow-up message is required.')
    item.text = text
    this.save()
    this.emitFollowUps(binding)
    return [...(binding.followUps ?? [])]
  }

  removeFollowUp(threadId: string, followUpId: string): QueuedFollowUp[] {
    const binding = this.binding(threadId)
    binding.followUps = (binding.followUps ?? []).filter((item) => item.id !== followUpId)
    this.save()
    this.emitFollowUps(binding)
    return [...binding.followUps]
  }

  moveFollowUp(threadId: string, followUpId: string, toIndex: number): QueuedFollowUp[] {
    const binding = this.binding(threadId)
    const list = [...(binding.followUps ?? [])]
    const fromIndex = list.findIndex((item) => item.id === followUpId)
    if (fromIndex < 0) throw new Error('Queued follow-up not found.')
    const [item] = list.splice(fromIndex, 1)
    list.splice(Math.max(0, Math.min(toIndex, list.length)), 0, item)
    binding.followUps = list
    this.save()
    this.emitFollowUps(binding)
    return [...list]
  }

  async steerFollowUp(threadId: string, followUpId: string): Promise<QueuedFollowUp[]> {
    const binding = this.binding(threadId)
    const item = binding.followUps?.find((followUp) => followUp.id === followUpId)
    if (!item) throw new Error('Queued follow-up not found.')
    const backend = await this.ensureStarted(binding.backendId)
    if (!this.busyThreads.has(threadId)) {
      binding.followUps = [item, ...(binding.followUps ?? []).filter((followUp) => followUp.id !== followUpId)]
      this.save()
      this.emitFollowUps(binding)
      await this.deliverNextFollowUp(threadId)
      return [...(binding.followUps ?? [])]
    }
    if (DEFINITIONS[binding.backendId].capabilities.steering === 'native' && backend.steer) {
      await backend.steer(binding.nativeSessionId, this.followUpParts(item))
      return this.removeFollowUp(threadId, followUpId)
    }
    binding.followUps = [item, ...(binding.followUps ?? []).filter((followUp) => followUp.id !== followUpId)]
    this.save()
    this.emitFollowUps(binding)
    await backend.abort(binding.nativeSessionId)
    return [...binding.followUps]
  }

  private async deliverNextFollowUp(threadId: string): Promise<void> {
    if (this.followUpDeliveries.has(threadId) || this.busyThreads.has(threadId)) return
    const binding = this.bindings.get(threadId)
    const item = binding?.followUps?.[0]
    if (!binding || !item) return
    this.followUpDeliveries.add(threadId)
    try {
      await this.sendMessage(threadId, this.followUpParts(item), item.options)
      binding.followUps = (binding.followUps ?? []).filter((followUp) => followUp.id !== item.id)
      this.save()
      this.emitFollowUps(binding)
      if (!this.busyThreads.has(threadId) && binding.followUps.length) {
        queueMicrotask(() => void this.deliverNextFollowUp(threadId))
      }
    } catch (error) {
      this.emit({
        type: 'session.error',
        properties: { sessionID: threadId, error: error instanceof Error ? error.message : String(error) },
        backendId: binding.backendId
      })
    } finally {
      this.followUpDeliveries.delete(threadId)
    }
  }

  threadForNative(backendId: BackendId, nativeThreadId: string): ThreadBusThread | undefined {
    const binding = this.bindingForNative(backendId, nativeThreadId)
    return binding ? this.threadBusInfo(binding) : undefined
  }

  threadInfo(threadId: string): ThreadBusThread | undefined {
    const binding = this.bindings.get(threadId)
    return binding ? this.threadBusInfo(binding) : undefined
  }

  threadList(projectId: string): ThreadBusThread[] {
    return [...this.bindings.values()]
      .filter((binding) => !projectId || binding.projectId === projectId)
      .map((binding) => this.threadBusInfo(binding))
      .sort((a, b) => a.title.localeCompare(b.title))
  }

  private threadBusInfo(binding: ThreadBinding): ThreadBusThread {
    return {
      id: binding.id,
      title: binding.title || 'Untitled thread',
      backendId: binding.backendId,
      projectId: binding.projectId,
      projectPath: binding.projectPath,
      executionPath: binding.executionPath,
      busy: this.busyThreads.has(binding.id)
    }
  }

  async threadMessages(threadId: string, limit: number): Promise<MessageWithParts[]> {
    return this.messagesList(threadId, limit)
  }

  async deliverThreadMessage(threadId: string, body: string): Promise<void> {
    await this.sendMessage(threadId, [{ type: 'text', text: body }], { mode: 'ask' })
  }

  async spawnWorktreeThread(threadId: string, instruction: string): Promise<ThreadBusThread> {
    const created = await this.forkIntoWorktree(threadId, instruction)
    const info = this.threadInfo(created.id)
    if (!info) throw new Error('The worktree thread was created but could not be registered.')
    return info
  }

  private async runCommand(
    threadId: string,
    command: string,
    args: string,
    options?: BackendMessageOptions
  ): Promise<MessageWithParts> {
    const binding = this.binding(threadId)
    const backend = await this.ensureStarted(binding.backendId)
    if (!backend.runCommand) throw new Error(`${DEFINITIONS[binding.backendId].label} does not support native slash commands.`)
    const message = await backend.runCommand(binding.nativeSessionId, command, args, options)
    return {
      info: { ...message.info, sessionID: threadId },
      parts: message.parts.map((part) => ({ ...part, sessionID: threadId }))
    }
  }

  emitThreadBus(snapshot: ThreadBusSnapshot): void {
    this.emit({ type: 'thread.bus.updated', properties: { snapshot } })
  }

  async abort(threadId: string): Promise<void> {
    const binding = this.binding(threadId)
    const backend = await this.ensureStarted(binding.backendId)
    await backend.abort(binding.nativeSessionId)
  }

  async fork(threadId: string, messageId?: string): Promise<SessionInfo> {
    const source = this.binding(threadId)
    const backend = await this.ensureStarted(source.backendId)
    const native = await backend.fork(source.nativeSessionId, messageId)
    if (native.id === source.nativeSessionId) return this.clone(threadId, source.backendId)
    const binding = this.registerNative(source.backendId, native, 'ralf', {
      kind: 'fork',
      sourceThreadId: threadId,
      sourceBackendId: source.backendId
    })
    binding.projectId = source.projectId
    binding.projectPath = source.projectPath
    binding.executionPath = source.executionPath
    binding.parentID = threadId
    this.save()
    return this.session(binding, native)
  }

  private async contextPacket(sourceThreadId: string, instruction?: string): Promise<string> {
    const source = this.binding(sourceThreadId)
    const sourceBackend = await this.ensureStarted(source.backendId)
    const messages = await sourceBackend.messagesList(source.nativeSessionId)
    const diffs = await sourceBackend.diffGet(source.nativeSessionId).catch(() => [])
    const diffSummary = diffs.slice(0, 30).map((diff) => `- ${diff.path}: ${diff.status ?? 'changed'}`).join('\n')
    return [
      '[R.A.L.F. CONTEXT HANDOFF]',
      `Source thread: ${source.title ?? sourceThreadId}`,
      `Source backend: ${source.backendId}`,
      `Project: ${source.projectId === 'global' ? 'Global chat' : source.projectPath}`,
      instruction ? `User instruction: ${instruction}` : 'Continue from this context. First summarize your understanding, then wait for or follow the user’s latest request.',
      diffSummary ? `Changed files reported by the source backend:\n${diffSummary}` : '',
      'Conversation transcript:',
      transcript(messages)
    ].filter(Boolean).join('\n\n')
  }

  async clone(threadId: string, backendId: BackendId, instruction?: string, options?: BackendMessageOptions): Promise<SessionInfo> {
    const source = this.binding(threadId)
    const packet = await this.contextPacket(threadId, instruction)
    const title = `${source.title ?? 'Untitled'} · ${DEFINITIONS[backendId].label}`
    const created = await this.sessionCreate(backendId, title, {
      kind: 'clone',
      sourceThreadId: threadId,
      sourceBackendId: source.backendId
    }, source.projectId === 'global' ? 'global' : 'current')
    await this.sendMessage(created.id, [{ type: 'text', text: packet }], { ...options, mode: options?.mode ?? 'ask' })
    return created
  }

  async forkIntoWorktree(threadId: string, instruction?: string, options?: BackendMessageOptions): Promise<SessionInfo> {
    if (!this.worktrees) throw new Error('Git worktrees are not available.')
    const source = this.binding(threadId)
    if (source.projectId === 'global' || !source.projectPath) throw new Error('Projectless chats cannot create Git worktrees.')
    const worktree = await this.worktrees.create({
      projectId: source.projectId,
      projectPath: source.projectPath,
      sourcePath: source.executionPath || source.projectPath,
      title: source.title,
      ownerThreadId: undefined
    })
    let packet: string
    let created: SessionInfo
    try {
      packet = await this.contextPacket(
        threadId,
        instruction ?? `Continue this conversation in the new Git worktree on branch ${worktree.branch}.`
      )
      created = await this.sessionCreateInScope(
        source.backendId,
        { projectId: source.projectId, projectPath: source.projectPath, executionPath: worktree.path },
        `${source.title ?? 'Untitled'} · worktree`,
        { kind: 'fork', sourceThreadId: threadId, sourceBackendId: source.backendId },
        worktree
      )
    } catch (error) {
      await this.worktrees.remove(worktree.id).catch(() => {})
      throw error
    }
    const binding = this.binding(created.id)
    await this.worktrees.setOwner(worktree.id, created.id)
    binding.worktree = { ...worktree, ownerThreadId: created.id }
    this.save()
    await this.sendMessage(created.id, [{ type: 'text', text: packet }], { ...options, mode: options?.mode ?? 'ask' })
    return this.session(binding)
  }

  private async cleanupWorktrees(): Promise<void> {
    if (!this.worktrees) return
    const result = await this.worktrees.cleanup().catch(() => undefined)
    if (!result) return
    const all = await this.worktrees.list()
    const worktrees = new Map(all.map((item) => [item.id, item]))
    let changed = false
    for (const binding of this.bindings.values()) {
      const current = binding.worktree ? worktrees.get(binding.worktree.id) : undefined
      if (current && current.status !== binding.worktree?.status) {
        binding.worktree = current
        changed = true
      }
    }
    if (changed) this.save()
  }

  async worktreeSettings(patch?: Partial<WorktreeSettings>): Promise<WorktreeSettings> {
    if (!this.worktrees) throw new Error('Git worktrees are not available.')
    return patch ? this.worktrees.setSettings(patch) : this.worktrees.settings()
  }

  async removeWorktree(id: string): Promise<WorktreeInfo> {
    if (!this.worktrees) throw new Error('Git worktrees are not available.')
    const owner = [...this.bindings.values()].find((binding) => binding.worktree?.id === id)
    if (owner && this.busyThreads.has(owner.id)) throw new Error('Stop the running agent before removing its worktree.')
    const removed = await this.worktrees.remove(id)
    for (const binding of this.bindings.values()) {
      if (binding.worktree?.id === id) binding.worktree = removed
    }
    this.save()
    return removed
  }

  async relay(sourceThreadId: string, targetThreadId: string, instruction?: string): Promise<SessionInfo> {
    if (sourceThreadId === targetThreadId) throw new Error('Choose a different target thread.')
    const packet = await this.contextPacket(sourceThreadId, instruction ?? 'Review this update and respond with anything the source thread should know.')
    await this.sendMessage(targetThreadId, [{ type: 'text', text: packet }], { mode: 'ask' })
    return this.sessionGet(targetThreadId)
  }

  async handle(request: BackendRequest): Promise<unknown> {
    if (request.type.startsWith('automation.')) {
      if (!this.automations) throw new Error('Automations are not available.')
      return this.automations.handle(request)
    }
    if (request.type.startsWith('mcp.')) {
      if (!this.mcpHub) throw new Error('MCP connections are not available.')
      return this.mcpHub.handle(request)
    }
    switch (request.type) {
      case 'backend.list': return this.descriptors()
      case 'backend.auth.status': return this.backendAuth?.statuses() ?? []
      case 'backend.defaults.set': return this.setDefaultModels(request.defaults)
      case 'thread.list': return this.sessionsList()
      case 'thread.create': return this.sessionCreate(request.backendId, request.title, undefined, request.scope)
      case 'thread.get': return this.sessionGet(request.threadId)
      case 'thread.delete': return this.sessionDelete(request.threadId)
      case 'thread.rename': return this.sessionRename(request.threadId, request.title)
      case 'thread.messages': return this.messagesList(request.threadId, request.limit)
      case 'thread.send': return this.sendMessage(request.threadId, request.parts, request.options)
      case 'thread.followups.list': return this.followUps(request.threadId)
      case 'thread.followups.add': return this.addFollowUp(request.threadId, request.text, request.attachments, request.options)
      case 'thread.followups.update': return this.updateFollowUp(request.threadId, request.followUpId, request.text)
      case 'thread.followups.remove': return this.removeFollowUp(request.threadId, request.followUpId)
      case 'thread.followups.move': return this.moveFollowUp(request.threadId, request.followUpId, request.toIndex)
      case 'thread.followups.steer': return this.steerFollowUp(request.threadId, request.followUpId)
      case 'thread.abort': return this.abort(request.threadId)
      case 'thread.todos': {
        const binding = this.binding(request.threadId)
        return (await this.ensureStarted(binding.backendId)).todosGet(binding.nativeSessionId)
      }
      case 'thread.permission': {
        const binding = this.binding(request.threadId)
        return (await this.ensureStarted(binding.backendId)).permissionRespond(
          binding.nativeSessionId,
          request.permissionId,
          request.response
        )
      }
      case 'thread.diff': {
        const binding = this.binding(request.threadId)
        return (await this.ensureStarted(binding.backendId)).diffGet(binding.nativeSessionId, request.messageId)
      }
      case 'thread.fork': return this.fork(request.threadId, request.messageId)
      case 'thread.revert': {
        const binding = this.binding(request.threadId)
        return (await this.ensureStarted(binding.backendId)).revert(binding.nativeSessionId, request.messageId)
      }
      case 'thread.unrevert': {
        const binding = this.binding(request.threadId)
        return (await this.ensureStarted(binding.backendId)).unrevert(binding.nativeSessionId)
      }
      case 'thread.command': return this.runCommand(request.threadId, request.command, request.arguments, request.options)
      case 'thread.compact': {
        const binding = this.binding(request.threadId)
        return (await this.ensureStarted(binding.backendId)).compact(binding.nativeSessionId, request.model)
      }
      case 'thread.models': {
        const id = request.threadId ? this.binding(request.threadId).backendId : request.backendId ?? 'opencode'
        return (await this.ensureStarted(id)).modelsList()
      }
      case 'thread.clone': return this.clone(request.threadId, request.backendId, request.instruction, request.options)
      case 'thread.worktree.create': return this.forkIntoWorktree(request.threadId, request.instruction, request.options)
      case 'worktree.list': {
        if (!this.worktrees) return []
        const projectId = request.threadId ? this.binding(request.threadId).projectId : this.currentScope.projectId
        return this.worktrees.list(projectId)
      }
      case 'worktree.settings.get': return this.worktreeSettings()
      case 'worktree.settings.set': return this.worktreeSettings({
        autoCleanupEnabled: request.autoCleanupEnabled,
        cleanupAfterDays: request.cleanupAfterDays
      })
      case 'worktree.remove': return this.removeWorktree(request.worktreeId)
      case 'thread.relay': return this.relay(request.sourceThreadId, request.targetThreadId, request.instruction)
      case 'thread.bus.get': {
        if (!this.threadBus) throw new Error('Thread collaboration is not available.')
        const binding = request.threadId ? this.binding(request.threadId) : undefined
        const scope = binding
          ? { projectId: binding.projectId, projectPath: binding.projectPath }
          : this.currentScope
        return this.threadBus.snapshot(scope.projectId, scope.projectPath)
      }
      case 'thread.bus.policy': {
        if (!this.threadBus) throw new Error('Thread collaboration is not available.')
        const binding = request.threadId ? this.binding(request.threadId) : undefined
        const scope = binding
          ? { projectId: binding.projectId, projectPath: binding.projectPath }
          : this.currentScope
        return this.threadBus.setPolicy(scope.projectId, scope.projectPath, request.policy)
      }
      case 'thread.bus.clear-failures': {
        if (!this.threadBus) throw new Error('Thread collaboration is not available.')
        const binding = request.threadId ? this.binding(request.threadId) : undefined
        const scope = binding
          ? { projectId: binding.projectId, projectPath: binding.projectPath }
          : this.currentScope
        return this.threadBus.clearFailures(scope.projectId, scope.projectPath)
      }
      case 'thread.qa.get': {
        if (!this.threadBus) throw new Error('QA tools are not available.')
        this.binding(request.threadId)
        return this.threadBus.qaStatus(request.threadId)
      }
      case 'thread.qa.policy': {
        if (!this.threadBus) throw new Error('QA tools are not available.')
        this.binding(request.threadId)
        return this.threadBus.setQaPolicy(request.threadId, request.policy)
      }
      case 'qa.default.get': {
        if (!this.threadBus) throw new Error('QA tools are not available.')
        return this.threadBus.qaDefault()
      }
      case 'qa.default.policy': {
        if (!this.threadBus) throw new Error('QA tools are not available.')
        return this.threadBus.setQaDefault(request.policy)
      }
    }
  }
}

export { textFromParts }
