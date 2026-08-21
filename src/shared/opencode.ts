import type { BackendId } from './backend'

export type ProviderID = 'anthropic' | 'openai' | 'google' | 'groq' | string

export interface SessionInfo {
  id: string
  /** Stable BOSS thread id. Native ids are deliberately kept behind this binding. */
  backendId?: BackendId
  nativeSessionId?: string
  nativeSessionOwnership?: 'boss' | 'imported'
  projectId?: string
  /** Logical project root shared by its main checkout and managed worktrees. */
  projectPath?: string
  /** Directory in which this thread's backend actually runs. */
  executionPath?: string
  worktree?: import('./worktree').WorktreeInfo
  title?: string
  time?: SessionTime
  path?: string
  directory?: string
  model?: SessionModel
  /** The thread's permission mode. Main owns it, so a mid-run change reaches
   *  the permission handler; the renderer mirrors it for display only. */
  mode?: import('./backend').BackendModeId
  /** Whether a run is in flight. Main owns this too: it marks the thread busy
   *  when it sends, before any backend event, so a renderer that opens or
   *  reloads mid-run reads the truth instead of inferring one from timestamps. */
  busy?: boolean
  parentID?: string
  lineage?: import('./supervision').ThreadLineage
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
  /** The tool a tool part called, as opencode sends it.
   *
   *  Opencode puts the name here, beside the state rather than inside it. The
   *  other backends build their parts by hand and put it in `state.tool`, so
   *  both spellings are real and code that needs the name has to read both. */
  tool?: string
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
    /** An image this part is, so the transcript can show it rather than name it.
     *
     *  `mime` says whether there is one at all. `url` is what an <img> loads:
     *  a data URL for something the user attached, which is small and already
     *  arrives that way, or a boss-image:// URL for a screenshot an agent took,
     *  whose bytes live beside the transcript instead of inside it. */
    mime?: string
    url?: string
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

/** How the Files tab should show one file. Mirrors PreviewKind in
 *  main/project-files.ts; the shapes are declared here because the renderer
 *  cannot import from the main process. */
export type ProjectPreviewKind = 'text' | 'image' | 'pdf' | 'binary'

export interface ProjectTreeNode {
  name: string
  path: string
  type: 'file' | 'directory'
  ignored?: boolean
  children?: ProjectTreeNode[]
}

export interface ProjectFilePreview {
  path: string
  /** Absolute path on disk, for handing to the OS or an editor. */
  absolute: string
  kind: ProjectPreviewKind
  /** Set for image and pdf: the boss-file:// URL the renderer loads. */
  url?: string
  mime?: string
  /** Set for text. */
  content?: string
  render?: 'code' | 'markdown' | 'html'
  size: number
  /** Why there is nothing to show, when there is nothing to show. */
  note?: string
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
  kind: 'main' | 'side' | 'fork' | 'delegate'
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

/** Ids BOSS mints itself, for transcript entries no backend will ever report.
 *
 *  A steered message is folded into the run the backend is already doing, and
 *  a tool image is produced by BOSS rather than by the model, so neither comes
 *  back in a native history list. Anything reconciling BOSS's transcript
 *  against that list has to know the difference: treating "the backend did not
 *  mention it" as "it never existed" deletes the message the user just sent. */
const LOCAL_MESSAGE_PREFIXES = ['steer-', 'assistant-tool-image-'] as const

/** Whether this transcript entry was authored by BOSS rather than a backend.
 *
 *  Callers use it to exempt an entry from pruning. Prefix-matched because the
 *  id is the only thing that survives into the store — the row does not record
 *  who wrote it. */
export function isLocallyAuthoredMessageId(messageId: string): boolean {
  return LOCAL_MESSAGE_PREFIXES.some((prefix) => messageId.startsWith(prefix))
}

/** The tool a part called, wherever the backend put the name.
 *
 *  Opencode sends it as the part's own `tool` field. The backends that build
 *  parts by hand — claude, codex, pi — put it in `state.tool` instead. Code
 *  that matches on the name has to read both, or it silently matches nothing
 *  for half the backends. */
export function partToolName(part: Pick<Part, 'tool' | 'state'>): string {
  return String(part.tool ?? part.state?.tool ?? '').toLowerCase()
}

/** Whether a part is a finished write to the todo list.
 *
 *  Opencode publishes no todo event, so this is what tells BOSS the list has
 *  changed and is worth re-reading. It matches on the tool name because
 *  `todowrite` is an ordinary tool call like any other. */
export function isCompletedTodoToolCall(part: Pick<Part, 'type' | 'tool' | 'state'>): boolean {
  if (part.type !== 'tool' || part.state?.status !== 'completed') return false
  return partToolName(part).includes('todo')
}
