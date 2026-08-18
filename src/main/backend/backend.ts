import type { BackendId, BackendMessageOptions, BackendModeId } from '@shared/backend'
import type { SandboxSettings } from '@shared/sandbox'
import type { ThreadBusConnection, ThreadBusToolCall } from '@shared/thread-bus'

export interface BackendInfo {
  id: BackendId
  engine: string
  version?: string
  healthy: boolean
  projectPath?: string
}

export interface ModelInfo {
  id: string
  name?: string
  provider?: string
  variants?: string[]
  source?: 'local' | 'cloud' | 'custom'
}

export interface ThinkingLevel {
  level: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}

import type {
  SessionInfo,
  MessageWithParts,
  Todo,
  FileDiff,
  FileNode,
  FileContent,
} from '@shared/opencode'
import type { EventMessage } from '@shared/opencode'

export interface McpServerConfig {
  type: 'local'
  command: string[]
  environment?: Record<string, string>
}

export interface Backend {
  readonly id: BackendId

  /** Lifecycle */
  start(): Promise<void>
  stop(): Promise<void>

  setProject(path: string): Promise<void>
  info(): BackendInfo

  /** MCP tool servers (computer use, etc.). Returns false if the backend can't host MCP. */
  supportsMcp(): boolean
  registerMcpServer(name: string, config: McpServerConfig): Promise<boolean>
  unregisterMcpServer(name: string): Promise<void>

  /** Optional trusted host tools. The backend supplies the native caller thread id. */
  setThreadBusHandler?(handler: (call: ThreadBusToolCall) => Promise<unknown>): void

  /** Optional loopback connection for backends that load tools in child processes. */
  configureThreadBus?(connection: ThreadBusConnection): void

  /** Events */
  onEvent(cb: (ev: EventMessage) => void): () => void

  /** Sessions */
  sessionsList(): Promise<SessionInfo[]>
  sessionCreate(title?: string, directory?: string): Promise<SessionInfo>
  setSessionDirectory?(id: string, directory: string): void
  /** Tell a sandboxing backend what the sandbox may do. Optional: only
   *  backends that run the agent in a sandbox implement it. */
  setSandbox?(settings: SandboxSettings): void
  sessionDelete(id: string): Promise<void>
  sessionRename(id: string, title: string): Promise<SessionInfo>
  sessionGet(id: string): Promise<SessionInfo>

  /** Messages */
  messagesList(sessionId: string, limit?: number): Promise<MessageWithParts[]>
  sendMessage(
    sessionId: string,
    parts: unknown[],
    opts?: BackendMessageOptions
  ): Promise<void>
  /** Add input to the active run. Only present when the descriptor advertises native steering. */
  steer?(sessionId: string, parts: unknown[]): Promise<void>
  abort(sessionId: string): Promise<void>

  /** Models */
  modelsList(): Promise<ModelInfo[]>
  modelSelect(providerId: string, modelId: string): Promise<void>

  /** Thinking */
  thinkingGet(): Promise<ThinkingLevel>
  thinkingSet(level: ThinkingLevel['level']): Promise<void>

  /** Todos / Permissions */
  todosGet(sessionId: string): Promise<Todo[]>
  permissionRespond(sessionId: string, permissionId: string, response: 'once' | 'always' | 'reject'): Promise<void>
  /** Tell a running agent its permission mode changed.
   *
   *  Optional: only backends that can be told mid-run implement it. Returns
   *  true when the running agent accepted the change, false when the mode will
   *  not apply until the next turn — the caller reports that difference rather
   *  than pretending the switch landed. */
  permissionModeSet?(sessionId: string, mode: BackendModeId): Promise<boolean>
  /** Answer a question the agent asked. Optional: only backends that can put a
   *  question to the user implement it, and the answers go back the way that
   *  backend expects rather than through opencode's HTTP endpoint. */
  questionRespond?(sessionId: string, requestId: string, answers: string[][]): Promise<void>

  /** Files / Diff */
  diffGet(sessionId: string, messageId?: string): Promise<FileDiff[]>
  fileTree(path?: string): Promise<FileNode[]>
  fileContent(path: string): Promise<FileContent>

  /** Fork / Revert */
  fork(sessionId: string, messageId?: string): Promise<SessionInfo>
  revert(sessionId: string, messageId: string): Promise<void>
  unrevert(sessionId: string): Promise<void>

  /** Optional backend-native slash command execution. */
  runCommand?(
    sessionId: string,
    command: string,
    args: string,
    opts?: BackendMessageOptions
  ): Promise<MessageWithParts>

  /** Optional native compaction. Implementations may safely no-op. */
  compact(sessionId: string, model?: { providerID: string; modelID: string }): Promise<void>
}
