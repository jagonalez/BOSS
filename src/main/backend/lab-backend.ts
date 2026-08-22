import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { chmodSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Backend, McpServerConfig, ModelInfo, ThinkingLevel } from './backend'
import type { BackendMessageOptions, BackendModeId, LabConnection, LabConnectionModel, LabConnectionsSettings, LabConnectionUpdate } from '@shared/backend'
import type { EventMessage, FileContent, FileDiff, FileNode, MessageWithParts, SessionInfo, Todo } from '@shared/opencode'
import type { ThreadBusToolCall } from '@shared/thread-bus'
// @ts-expect-error Application builds use bundler resolution.
import { THREAD_TOOL_DEFINITIONS, isThreadTool } from './lab-thread-tools.ts'
// The explicit extensions keep this module executable under Node's type-stripping test runner.
// @ts-expect-error Application builds use bundler resolution.
import { LabEngine, type EngineGate, type EngineSink } from './lab-engine.ts'
// @ts-expect-error Application builds use bundler resolution.
import { permissionForTool } from './lab-tools.ts'
import type { LabFunctionCall } from './lab-tool-call.ts'
// @ts-expect-error Application builds use bundler resolution.
import { configFromEnv, type LabEnvConfig } from './lab-config.ts'

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
  secretFile?: string
}

interface StoredLabConnection {
  id: string
  name: string
  baseUrl: string
  manualModels: string[]
  models: LabConnectionModel[]
}

interface StoredLabConfig {
  version?: number
  connections?: StoredLabConnection[]
  /** Version-one singleton fields, migrated as the stable default connection. */
  baseUrl?: string
  model?: string
}

function storedConfig(file: string): StoredLabConfig {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as StoredLabConfig
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

function uniqueModels(models: LabConnectionModel[]): LabConnectionModel[] {
  const byId = new Map<string, LabConnectionModel>()
  for (const model of models) {
    const id = model.id.trim()
    if (id && !byId.has(id)) byId.set(id, { ...model, id })
  }
  return [...byId.values()]
}

export function normaliseLabEndpoint(value: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('Enter a valid http:// or https:// endpoint URL.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Lab endpoints must use http:// or https://.')
  }
  if (url.search || url.hash) throw new Error('The endpoint URL cannot include a query or fragment.')
  // A host-only URL gets the conventional OpenAI root. Preserve an explicit
  // path because gateways and compatibility layers often use a custom one.
  url.pathname = url.pathname.replace(/\/+$/, '') || '/v1'
  return url.toString().replace(/\/$/, '')
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
  private engine: LabEngine
  private readonly storeFile: string
  private readonly configFile: string
  private readonly secretFile: string
  private readonly baseConfig: LabEnvConfig
  private connections: LabConnection[]
  private apiKeys: Record<string, string>
  private eventCb?: (event: EventMessage) => void
  private projectPath = ''
  private healthy = false
  private readonly pendingPermissions = new Map<string, PendingPermission>()
  private readonly liveText = new Map<string, string>()
  private readonly liveReasoning = new Map<string, string>()
  private threadBusHandler?: (call: ThreadBusToolCall) => Promise<unknown>

  constructor(options: LabBackendOptions = {}) {
    this.storeFile = options.storeFile ?? userDataFile('lab-threads.json')
    this.configFile = options.configFile ?? userDataFile('lab-config.json')
    this.secretFile = options.secretFile ?? userDataFile('lab-api-key.bin')
    this.baseConfig = configFromEnv()
    this.apiKeys = this.savedApiKeys()
    this.connections = this.loadConnections()
    this.engine = this.createEngine()
    void this.refreshHealth()
  }

  private createEngine(): LabEngine {
    return new LabEngine({
      storeFile: this.storeFile,
      configFile: this.configFile,
      config: this.baseConfig,
      sink: this.sink(),
      gate: { request: (sessionId, call, args, signal) => this.requestPermission(sessionId, call, args, signal) },
      // The thread bus reaches Lab as external tools rather than over MCP: Lab
      // has no MCP client, and the host can hand over an execute function
      // directly. They appear only once BOSS installs a handler, so the CLI and
      // ACP server see the built-in tools alone.
      externalTools: {
        definitions: () => (this.threadBusHandler ? THREAD_TOOL_DEFINITIONS : []),
        execute: async (name: string, args: Record<string, unknown>, sessionId: string) => {
          if (!this.threadBusHandler || !isThreadTool(name)) throw new Error(`Unknown tool: ${name}`)
          const result = await this.threadBusHandler({
            nativeThreadId: sessionId,
            tool: name as ThreadBusToolCall['tool'],
            arguments: args
          })
          return typeof result === 'string' ? result : JSON.stringify(result, null, 2)
        }
      }
    })
  }

  private savedApiKeys(): Record<string, string> {
    try {
      const { safeStorage } = nodeRequire('electron') as typeof import('electron')
      if (!safeStorage.isEncryptionAvailable()) return {}
      const decrypted = safeStorage.decryptString(readFileSync(this.secretFile)).trim()
      if (!decrypted) return {}
      try {
        const parsed = JSON.parse(decrypted) as Record<string, unknown>
        return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[1].trim())))
      } catch {
        // PR #126 stored one raw key. Its singleton becomes the default profile.
        return { default: decrypted }
      }
    } catch {
      return {}
    }
  }

  private saveApiKeys(): void {
    const entries = Object.entries(this.apiKeys).filter(([, value]) => value.trim())
    if (entries.length === 0) {
      try { unlinkSync(this.secretFile) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      return
    }
    const { safeStorage } = nodeRequire('electron') as typeof import('electron')
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable on this system.')
    writeFileSync(this.secretFile, safeStorage.encryptString(JSON.stringify(Object.fromEntries(entries))), { mode: 0o600 })
    chmodSync(this.secretFile, 0o600)
  }

  private loadConnections(): LabConnection[] {
    const stored = storedConfig(this.configFile)
    const configured = Array.isArray(stored.connections) ? stored.connections : []
    if (Array.isArray(stored.connections)) {
      return configured.flatMap((connection) => {
        if (!connection || typeof connection.id !== 'string' || typeof connection.name !== 'string' || typeof connection.baseUrl !== 'string') return []
        try {
          const manualModels = Array.isArray(connection.manualModels) ? connection.manualModels.map(String).map((id) => id.trim()).filter(Boolean) : []
          const models = Array.isArray(connection.models) ? uniqueModels(connection.models.filter((model) => model && typeof model.id === 'string')) : []
          return [{
            id: connection.id,
            name: connection.name.trim() || 'Unnamed connection',
            baseUrl: normaliseLabEndpoint(connection.baseUrl),
            apiKeyConfigured: Boolean(this.apiKeys[connection.id]),
            healthy: false,
            manualModels,
            models: uniqueModels([...models, ...manualModels.map((id) => ({ id, source: 'custom' as const }))])
          }]
        } catch {
          return []
        }
      })
    }
    const baseUrl = normaliseLabEndpoint(stored.baseUrl ?? this.baseConfig.baseUrl)
    const model = stored.model?.trim() || this.baseConfig.defaultModel
    return [{
      id: 'default',
      name: 'Default',
      baseUrl,
      apiKeyConfigured: Boolean(this.apiKeys.default || this.baseConfig.apiKey),
      healthy: false,
      manualModels: [model],
      models: [{ id: model, source: baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1') ? 'local' : 'custom' }]
    }]
  }

  private apiKeyFor(connectionId: string): string | undefined {
    return this.apiKeys[connectionId] ?? (connectionId === 'default' ? this.baseConfig.apiKey : undefined)
  }

  private persistConnections(): void {
    const connections: StoredLabConnection[] = this.connections.map(({ id, name, baseUrl, manualModels, models }) => ({
      id, name, baseUrl, manualModels, models
    }))
    writeFileSync(this.configFile, JSON.stringify({ version: 2, connections }, null, 2), { mode: 0o600 })
    chmodSync(this.configFile, 0o600)
  }

  labConnections(): LabConnectionsSettings {
    return { connections: this.connections.map((connection) => ({ ...connection, manualModels: [...connection.manualModels], models: connection.models.map((model) => ({ ...model })), apiKeyConfigured: Boolean(this.apiKeyFor(connection.id)) })) }
  }

  async saveLabConnection(update: LabConnectionUpdate): Promise<LabConnectionsSettings> {
    const name = update.name.trim()
    if (!name) throw new Error('Enter a name for this connection.')
    const baseUrl = normaliseLabEndpoint(update.baseUrl)
    const id = update.id ?? randomUUID()
    const existing = this.connections.find((connection) => connection.id === id)
    if (update.id && !existing) throw new Error('That Lab connection no longer exists.')
    if (this.connections.some((connection) => connection.id !== id && connection.name.toLowerCase() === name.toLowerCase())) {
      throw new Error('Use a unique name for each Lab connection.')
    }
    if (update.apiKey !== undefined && update.clearApiKey) throw new Error('Set a new API key or clear the saved key, not both.')
    if (update.apiKey !== undefined || update.clearApiKey) {
      const previous = this.apiKeys[id]
      try {
        if (update.apiKey !== undefined) {
          const apiKey = update.apiKey.trim()
          if (!apiKey) throw new Error('Enter an API key or leave the field blank.')
          this.apiKeys[id] = apiKey
        } else {
          delete this.apiKeys[id]
        }
        this.saveApiKeys()
      } catch (error) {
        if (previous === undefined) delete this.apiKeys[id]
        else this.apiKeys[id] = previous
        throw error
      }
    }
    const manualModels = [...new Set(update.manualModels.map((model) => model.trim()).filter(Boolean))]
    const endpoint = { baseUrl, apiKey: this.apiKeyFor(id) }
    const discovered = await this.engine.listModels(endpoint)
    const models = uniqueModels([
      ...discovered.map(({ id: modelId, name: modelName, source }) => ({ id: modelId, name: modelName, source })),
      ...manualModels.map((modelId) => ({ id: modelId, source: 'custom' as const }))
    ])
    const healthy = discovered.length > 0 || await this.engine.checkHealth(endpoint)
    const connection: LabConnection = {
      id, name, baseUrl,
      apiKeyConfigured: Boolean(endpoint.apiKey),
      healthy,
      manualModels,
      models
    }
    if (existing) this.connections = this.connections.map((item) => item.id === id ? connection : item)
    else this.connections = [...this.connections, connection]
    this.healthy = this.connections.some((item) => item.healthy)
    this.persistConnections()
    return this.labConnections()
  }

  async deleteLabConnection(connectionId: string): Promise<LabConnectionsSettings> {
    if (!this.connections.some((connection) => connection.id === connectionId)) throw new Error('That Lab connection no longer exists.')
    this.connections = this.connections.filter((connection) => connection.id !== connectionId)
    this.healthy = this.connections.some((connection) => connection.healthy)
    delete this.apiKeys[connectionId]
    this.saveApiKeys()
    this.persistConnections()
    return this.labConnections()
  }

  private connection(connectionId?: string): LabConnection {
    const selected = connectionId ? this.connections.find((item) => item.id === connectionId) : undefined
    if (connectionId && connectionId !== 'lab' && !selected) throw new Error('This Lab API connection no longer exists. Choose another model in the thread toolbar.')
    const connection = selected ?? this.connections[0]
    if (!connection) throw new Error('Add a Lab API connection in Settings before starting a Lab thread.')
    return connection
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
      onReasoningDelta: (_sessionId, messageId, delta) => {
        // Reasoning streams the same way, as its own replaceable part — it is
        // what the user watches during the long quiet rounds a reasoning model
        // spends before its first token of answer.
        const text = `${this.liveReasoning.get(messageId) ?? ''}${delta}`
        this.liveReasoning.set(messageId, text)
        this.emit({ type: 'message.part.updated', part: { id: `${messageId}-reasoning`, type: 'reasoning', sessionID: _sessionId, messageID: messageId, text } })
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
    const snapshot = [...this.connections]
    const statuses = new Map(await Promise.all(snapshot.map(async (connection) => [connection.id, await this.engine.checkHealth({
      baseUrl: connection.baseUrl,
      apiKey: this.apiKeyFor(connection.id)
    })] as const)))
    this.connections = this.connections.map((connection) => ({ ...connection, healthy: statuses.get(connection.id) ?? connection.healthy }))
    this.healthy = this.connections.some((connection) => connection.healthy)
  }

  async start(): Promise<void> {
    this.engine.start()
    await this.refreshHealth()
  }

  async stop(): Promise<void> {
    this.engine.stop()
    this.connections = this.connections.map((connection) => ({ ...connection, healthy: false }))
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

  setThreadBusHandler(handler: (call: ThreadBusToolCall) => Promise<unknown>): void {
    this.threadBusHandler = handler
  }

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
    const connection = this.connection(options?.model?.providerID)
    await this.engine.sendMessage(sessionId, textFromParts(parts), {
      mode: options?.mode,
      model: options?.model?.modelID ?? connection.models[0]?.id,
      context: options?.context,
      baseUrl: connection.baseUrl,
      apiKey: this.apiKeyFor(connection.id)
    })
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
    return this.connections.flatMap((connection) => connection.models.map((model) => ({
      ...model,
      provider: connection.id,
      providerName: connection.name
    })))
  }

  async modelSelect(providerId: string, modelId: string): Promise<void> {
    this.connection(providerId)
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
    const connection = this.connection(model?.providerID)
    await this.engine.compact(sessionId, model?.modelID, { baseUrl: connection.baseUrl, apiKey: this.apiKeyFor(connection.id) })
    this.emit({ type: 'session.compacted', sessionID: sessionId })
  }
}
