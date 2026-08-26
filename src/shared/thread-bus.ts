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
  // Like reports, workflows are local to BOSS and scoped to the caller's own
  // project, so they are not gated by the collaboration policy.
  | 'boss_workflow_list'
  | 'boss_workflow_create'
  | 'boss_workflow_update'
  | 'boss_workflow_run'
  | 'boss_workflow_runs'
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

/** The script contract, told to agents once here rather than re-guessed per
 *  backend. What an agent believes the primitives are decides whether the
 *  workflows it writes actually run. */
export const WORKFLOW_TOOL_DESCRIPTIONS = {
  list: 'List the durable BOSS workflows for this project (and global ones): id, name, triggers, whether the user has enabled them, and the latest run. Start here before creating or running one.',
  create:
    'Create a durable BOSS workflow: a small JavaScript script whose steps are journaled and replayed, so a run survives app restarts mid-sequence and resumes exactly where it left off. Use one whenever work must outlive this conversation — watching CI or a PR, a recurring check, a multi-agent pipeline. The script runs in a sandbox with ONLY these async primitives: ' +
    'agent(prompt, {backendId?, model?: {providerID, modelID}, mode?, workspace?: "worktree"|"project"|"none", maxMinutes?, title?}) runs an unattended agent conversation, resolving to {status: "success"|"failure"|"timeout"|"aborted", summary, text, changedFiles, threadId} — branch on status to escalate to a stronger backend; ' +
    'judge(input, options[], {rubric?}) classifies with a forced-verdict model call, resolving to {verdict, reason} — use it for every notify-or-not or is-this-real decision instead of guessing inline; ' +
    'waitFor({type, filters?}, {timeoutMs?}) suspends durably (days are fine, restarts are fine) until a matching event arrives, resolving to the event or null on timeout — event types include cron.fired, github.push, github.pull_request, github.pull_request_review, github.pull_request_review_comment, github.issue_comment, github.workflow_run, github.check_suite, with flat data fields (repo, branch, prNumber, author, conclusion, …) matched by filters; ' +
    'sleep(ms); notify(body, {title?, attention?}) pings the user (budgeted, keep it rare); ask(question, choices?) suspends until the user answers and resolves to their text; ' +
    'state.get(key) / state.set(key, value) persist across runs of this workflow (alert history, seen ids); log(message) journals a progress note; ' +
    'pr(agentOutcome, {title?, body?, baseBranch?, draft?}) opens a change request from that agent step\'s checkout. ' +
    'The triggering event is in scope as `event`. Determinism rules: Date.now(), argless new Date(), and Math.random() throw — take time from event.at and randomness from journaled inputs. return a JSON-safe value as the run result. ' +
    'Unless the user has set workflow approval to auto, new workflows start disabled: cron/event triggers stay dormant until the user enables them in the Workflows page. boss_workflow_run executes one immediately regardless, under this conversation\'s supervision.',
  update:
    'Edit a workflow this project owns (script, name, description, triggers, overlap). Under ask-mode approval an edited workflow is disabled again until the user re-enables it — editing is how you iterate, enabling is how the user approves. Runs already in flight replay against the new script: steps before the first changed call keep their results.',
  run: 'Run a workflow once, now, regardless of whether it is enabled. Returns the run id, and the finished run\'s result is delivered back to this conversation as a message — no need to poll. Use this to test a workflow you just created.',
  runs: 'Recent runs of a workflow (or all workflows in this project): status, error, result, and each journaled step with its label and state. A run with status "waiting" is parked on waitFor/ask — that is normal, not stuck.',
  name: 'Short human-facing name, e.g. "Datadog alert watcher".',
  description: 'One or two sentences on what it watches and when it pings the user.',
  script: 'The JavaScript script body. Only the documented primitives exist — no require, fetch, fs, or timers.',
  cron: 'Five-field cron expression (local time) to run on a schedule, e.g. "*/20 * * * *". Omit for event-only or manual workflows.',
  eventType: 'Event type that triggers a run, e.g. "github.pull_request". Supports a trailing wildcard ("github.*"). Omit for cron-only or manual workflows.',
  eventFilters: 'Equality filters on the trigger event\'s data fields, e.g. {"repo": "acme/api", "branch": "main"}.',
  workflowId: 'Workflow id from boss_workflow_list or boss_workflow_create.',
  limit: 'How many recent runs to return (1-20, default 5).'
} as const

export interface ThreadBusToolCall {
  nativeThreadId: string
  tool: ThreadBusAgentTool
  arguments: unknown
}
