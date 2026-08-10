export type ProviderID = 'anthropic' | 'openai' | 'google' | 'groq' | string

export interface SessionInfo {
  id: string
  title?: string
  time?: SessionTime
  path?: string
  directory?: string
  model?: SessionModel
}

export interface SessionTime {
  created?: number
  updated?: number
}

export interface SessionModel {
  id?: string
  provider?: string
}

export interface MessageInfo {
  id: string
  sessionID: string
  role: 'user' | 'assistant'
  model?: SessionModel
  time?: { created?: number; completed?: number }
  tokens?: number
  error?: unknown
}

export type PartType = 'text' | 'tool' | 'reasoning' | 'snapshot' | 'file' | 'step' | 'agent'

export interface Part {
  id: string
  type: PartType
  sessionID: string
  messageID: string
  text?: string
  time?: { created?: number; completed?: number; start?: number; end?: number }
  state?: {
    status?: 'pending' | 'running' | 'completed' | 'error' | 'cancelled' | 'interrupted'
    error?: string
    tool?: string
    title?: string
    input?: unknown
    output?: unknown
    metadata?: Record<string, unknown>
    name?: string
    path?: string
    content?: string
    text?: string
  }
}

export interface MessageWithParts {
  info: MessageInfo
  parts: Part[]
}

export interface Todo {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  sessionID: string
}

export interface FileDiff {
  path: string
  original?: string
  content: string
  status?: string
  additions?: number
  deletions?: number
  after?: string
  before?: string
}

export interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  absolute?: string
  ignored?: boolean
  children?: FileNode[]
}

export interface FileContent {
  path: string
  content: string
  lineCount?: number
}

export interface FileStatus {
  path: string
  status: string
  additions?: number
  deletions?: number
}

export interface Project {
  id: string
  path?: string
  worktree?: string
  directory?: string
  title?: string
}
export interface VcsInfo {
  repo?: string
  branch?: string
  ahead?: number
  behind?: number
  status?: FileStatus[]
}

export interface Agent {
  id: string
  name?: string
  description?: string
  mode?: string
}

export interface Command {
  name: string
  description?: string
  agent?: string
  model?: string
  template: string
  subtask?: boolean
}

export interface Provider {
  id: string
  name?: string
  models?: Array<{ id: string; name?: string }>
}

export interface ConfigInfo {
  theme?: string
  agents?: Record<string, unknown>
  [key: string]: unknown
}

export interface PermissionRequest {
  id: string
  sessionID: string
  permissionType?: string
  description?: string
  tool?: string
  input?: unknown
}

export type EventMessage =
  | { type: 'session.updated'; session: SessionInfo }
  | { type: 'message.updated'; message: MessageInfo }
  | { type: 'message.part.updated'; part: Part }
  | { type: 'session.error'; sessionID: string; error: string }
  | { type: 'message.part.created'; part: Part }
  | { type: 'session.todo.updated'; sessionID: string; todos: Todo[] }
  | { type: 'permission.updated'; permission: PermissionRequest }
  | { type: 'server.connected' }
  | { type: 'server.disconnected' }
  | { type: 'config.updated' }
  | { type: 'agent.updated' }
  | { type: 'unknown'; raw: string }
