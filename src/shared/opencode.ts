import type { BackendId } from './backend'

export type ProviderID = 'anthropic' | 'openai' | 'google' | 'groq' | string

export interface SessionInfo {
  id: string
  /** Stable R.A.L.F. thread id. Native ids are deliberately kept behind this binding. */
  backendId?: BackendId
  nativeSessionId?: string
  title?: string
  time?: SessionTime
  path?: string
  directory?: string
  model?: SessionModel
  parentID?: string
  lineage?: {
    kind: 'fork' | 'clone' | 'relay'
    sourceThreadId: string
    sourceBackendId?: BackendId
  }
}

export interface SessionTime {
  created?: number
  updated?: number
  compacting?: number
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

export type PartType = 'text' | 'tool' | 'reasoning' | 'snapshot' | 'file' | 'step' | 'agent' | 'compaction'

export interface Part {
  id: string
  type: PartType
  sessionID: string
  messageID: string
  text?: string
  auto?: boolean
  overflow?: boolean
  tail_start_id?: string
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
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  priority?: string
  sessionID?: string
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

export interface ReviewFinding {
  file: string
  severity: 'error' | 'warning' | 'info'
  summary: string
}

export interface ReviewRun {
  id: string
  target: string
  baseSha: string
  findings: ReviewFinding[]
  createdAt: number
  stale: boolean
}

export interface SessionMeta {
  sessionId: string
  projectPath?: string
  kind: 'main' | 'side' | 'fork'
  forkedFrom?: { sessionId: string; messageId?: string }
  gitBranch?: string
  reviews: ReviewRun[]
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
  permission: string
  patterns?: string[]
  metadata?: Record<string, unknown>
  always?: string[]
  tool?: { messageID?: string; callID?: string }
  time?: { created?: number }
}

export interface QuestionOption {
  label: string
  description?: string
}

export interface QuestionInfo {
  question: string
  header?: string
  options?: QuestionOption[]
  multiple?: boolean
  custom?: boolean
}

export interface QuestionRequest {
  id: string
  sessionID: string
  questions: QuestionInfo[]
  tool?: { messageID?: string; callID?: string }
}

export type QuestionAnswer = string[]

export type EventMessage =
  | { type: 'session.updated'; session: SessionInfo }
  | { type: 'session.created'; session: SessionInfo }
  | { type: 'session.deleted'; session: SessionInfo }
  | { type: 'message.updated'; message: MessageInfo }
  | { type: 'message.part.updated'; part: Part }
  | { type: 'session.error'; sessionID: string; error: string }
  | { type: 'message.part.created'; part: Part }
  | { type: 'session.todo.updated'; sessionID: string; todos: Todo[] }
  | { type: 'permission.asked'; permission: PermissionRequest }
  | { type: 'permission.updated'; permission: PermissionRequest }
  | { type: 'permission.replied'; sessionID: string; permissionID: string; response: string }
  | { type: 'question.asked'; question: QuestionRequest }
  | { type: 'question.replied'; sessionID: string; requestID: string; answers: QuestionAnswer[] }
  | { type: 'question.rejected'; sessionID: string; requestID: string }
  | { type: 'session.status'; sessionID: string; status: { type: 'idle' | 'busy' | 'retry' } }
  | { type: 'session.idle'; sessionID: string }
  | { type: 'session.compacted'; sessionID: string }
  | { type: 'server.connected' }
  | { type: 'server.disconnected' }
  | { type: 'config.updated' }
  | { type: 'agent.updated' }
  | { type: 'unknown'; raw: string }
