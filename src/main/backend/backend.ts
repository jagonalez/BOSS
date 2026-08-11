export type BackendId = 'opencode' | 'pi' | 'claude'

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

  /** Events */
  onEvent(cb: (ev: EventMessage) => void): () => void

  /** Sessions */
  sessionsList(): Promise<SessionInfo[]>
  sessionCreate(title?: string): Promise<SessionInfo>
  sessionDelete(id: string): Promise<void>
  sessionRename(id: string, title: string): Promise<SessionInfo>
  sessionGet(id: string): Promise<SessionInfo>

  /** Messages */
  messagesList(sessionId: string, limit?: number): Promise<MessageWithParts[]>
  sendMessage(
    sessionId: string,
    parts: unknown[],
    opts?: { model?: { providerID: string; modelID: string; variant?: string }; agent?: string }
  ): Promise<void>
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

  /** Files / Diff */
  diffGet(sessionId: string, messageId?: string): Promise<FileDiff[]>
  fileTree(path?: string): Promise<FileNode[]>
  fileContent(path: string): Promise<FileContent>

  /** Fork / Revert */
  fork(sessionId: string, messageId?: string): Promise<SessionInfo>
  revert(sessionId: string, messageId: string): Promise<void>
  unrevert(sessionId: string): Promise<void>
}
