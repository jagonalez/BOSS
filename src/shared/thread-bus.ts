import type { BackendId } from './backend'
import type { QaAgentTool } from './qa'

export type CollaborationPolicy = 'off' | 'read' | 'collaborate'
export type ThreadBusMessageStatus = 'queued' | 'delivered' | 'failed'

export interface ThreadBusThread {
  id: string
  title: string
  backendId: BackendId
  projectId: string
  projectPath: string
  executionPath: string
  busy: boolean
}

export interface ThreadBusMessage {
  id: string
  rootId: string
  fromThreadId: string
  toThreadId: string
  backendId: BackendId
  projectId: string
  projectPath: string
  body: string
  createdAt: number
  deliveredAt?: number
  status: ThreadBusMessageStatus
  error?: string
  replyTo?: string
  expectsReply: boolean
  hopCount: number
  maxTurns: number
}

/** A project whose policy differs from the default, so the settings list can
 *  show only what the user actually chose rather than every project ever
 *  opened. */
export interface CollaborationOverride {
  projectId: string
  projectPath: string
  policy: CollaborationPolicy
}

export interface ThreadBusSnapshot {
  projectId: string
  projectPath: string
  policy: CollaborationPolicy
  /** Applied to any project without an explicit override. */
  defaultPolicy: CollaborationPolicy
  /** Whether this project's policy is its own or inherited from the default. */
  source: 'project' | 'default'
  overrides: CollaborationOverride[]
  threads: ThreadBusThread[]
  messages: ThreadBusMessage[]
  toolBackends: BackendId[]
}

export interface ThreadBusConnection {
  url: string
  token: string
  tokenFor(backendId: BackendId, nativeThreadId: string): string
  /** Names of MCP-hub tools currently available to agents, mcp_<slug>_<tool>. */
  agentToolNames(): string[]
}

export type ThreadBusAgentTool =
  | 'boss_threads_list'
  | 'boss_threads_read'
  | 'boss_threads_send'
  | 'boss_threads_reply'
  | 'boss_threads_spawn_worktree'
  | 'boss_threads_use_worktree'
  | 'boss_threads_leave_worktree'
  // Not a boss_threads_* tool: it acts on the caller's own checkout rather than reaching another
  // thread, so it is not gated by the collaboration policy either.
  | 'boss_git_create_change_request'
  | 'boss_reports_create'
  | 'boss_reports_update'
  | 'boss_mcp_list'
  | 'boss_mcp_call'
  | `mcp_${string}`
  | QaAgentTool

/** What the agent is told the thread tools are for.
 *
 *  Shared because each backend registers these tools in its own format, and
 *  four copies of the same sentence drift apart. What an agent is told about a
 *  tool decides whether it ever reaches for one, so it is worth keeping in a
 *  single place. */
export const THREAD_TOOL_DESCRIPTIONS = {
  list: 'Find the other BOSS threads working in this project on the same backend. Start here when you need to know who else is working, or to get a thread id for reading or sending.',
  read: 'Catch up on what another thread has been doing, by reading its recent messages. Use it before asking a question the transcript already answers.',
  send: 'Say something to another BOSS thread — a question, a piece of context it lacks, or a task. It arrives durably, and a busy thread gets it when it finishes.',
  reply: 'Answer a message another thread sent this one. Only messages addressed here can be replied to.',
  /** The one that failed in practice: the old wording said "fork this
   *  conversation", which reads as one new thread, so a request to take on
   *  several items produced one thread instead of several. */
  spawnWorktree: 'Hand a piece of work to a new BOSS thread with its own Git worktree, so it proceeds independently of this one. Call it once per piece of work: asked to take on several items, spawn a thread for each rather than one thread for all of them. Omit agent to reuse this thread\'s agent; set it only when the task should run on a different configured agent. Each new thread starts from the instruction alone, so say what to do and why, not "the second item above".',
  spawnWorktreeInstruction: 'What the new thread should do, stated in full. It cannot see this conversation.',
  spawnWorktreeAgent: 'Agent backend for the child thread. Omit to reuse the current thread\'s agent.',
  leaveWorktree: 'Come off this thread\'s worktree and back to the project directory, once its work is committed or merged. Git refuses while anything is uncommitted or untracked, so nothing is lost by trying; the branch is kept either way.',
  useWorktree: 'Move this conversation onto its own Git worktree, so your changes are isolated from the project directory and from other threads. Use it when a conversation turns from working something out to changing files, and the user has not already put you on one. It keeps this conversation — nothing is handed off. It returns the new path: your working directory changes from your next message, not during this one, so do not start editing files in the new checkout until then. Fails harmlessly if this thread already has a worktree.',
  createChangeRequest: 'Publish the committed branch and open a pull request (GitHub) or merge request (GitLab) for this thread\'s checkout. Use it instead of running `gh pr create` or `glab mr create` yourself: BOSS uses its host credentials and GitHub publishing works even when the agent shell has no SSH key. Commit first; this refuses uncommitted files. Omit title and body to fill both from the commits.',
  createChangeRequestTitle: 'Title for the request. Omit together with body to fill both from the commits.',
  createChangeRequestBody: 'Description for the request, as Markdown. Omit together with title to fill both from the commits.',
  createChangeRequestBase: 'Branch to merge into. Omit to use the repository default.',
  createChangeRequestDraft: 'Open it as a draft.'
} as const

export const REPORT_TOOL_DESCRIPTIONS = {
  create: 'Create a durable report artifact in BOSS when the user asks for a report, brief, dashboard narrative, analysis, or other result worth keeping outside the chat. The body supports Markdown. Return the report id so you can refine it later.',
  update: 'Update a report artifact previously created by this thread. Pass only the fields that should change; pass an empty summary to remove it.',
  title: 'Short human-facing title for the report.',
  summary: 'Optional one- or two-sentence description shown in the report inbox.',
  body: 'Complete report content in Markdown.',
  reportId: 'Report id returned by boss_reports_create.'
} as const

export interface ThreadBusToolCall {
  nativeThreadId: string
  tool: ThreadBusAgentTool
  arguments: unknown
}
