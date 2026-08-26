import type { BackendId, BackendModeId, BackendModelPreference } from './backend'

/**
 * Durable workflows: the one execution engine for everything BOSS runs
 * unattended. A workflow is a small JavaScript script executed against a
 * fixed set of effectful primitives (agent, judge, waitFor, notify, ask,
 * state, sleep, pr). Every primitive call is journaled; execution is always
 * replay-from-the-top, so a run survives app restarts mid-sequence and
 * resumes exactly where it left off.
 *
 * This supersedes the bespoke state machines that preceded it (automation
 * runs, task-policy reviewer chains, managed assistant workflow runs).
 */

/** Normalized envelope for everything that can wake a workflow. */
export interface BossEvent {
  id: string
  /** Dotted event name, e.g. 'cron.fired', 'github.workflow_run.completed',
   *  'github.pull_request.review', 'workflow.answer', 'manual'. */
  type: string
  at: number
  /** Absolute project path the event belongs to, '' when global. */
  projectPath?: string
  /** Flat payload. Subscription filters match on top-level fields. */
  data: Record<string, unknown>
}

export interface EventPattern {
  /** Exact event type, or a prefix wildcard like 'github.*'. */
  type: string
  projectPath?: string
  /** Equality filters against event.data fields (compared as strings). */
  filters?: Record<string, string | number | boolean>
}

export function matchesPattern(pattern: EventPattern, event: BossEvent): boolean {
  if (pattern.type.endsWith('*')) {
    if (!event.type.startsWith(pattern.type.slice(0, -1))) return false
  } else if (pattern.type !== event.type) {
    return false
  }
  if (pattern.projectPath !== undefined && pattern.projectPath !== (event.projectPath ?? '')) return false
  if (pattern.filters) {
    for (const [key, expected] of Object.entries(pattern.filters)) {
      if (String(event.data[key]) !== String(expected)) return false
    }
  }
  return true
}

export type SubscriptionTarget =
  /** Resume a parked run: deliver the event as the result of journal entry `seq`. */
  | { kind: 'resume'; runId: string; seq: number }
  /** Start a new run of a workflow. */
  | { kind: 'trigger'; workflowId: string }

export interface WorkflowSubscription {
  id: string
  target: SubscriptionTarget
  /** Absent for pure timers (sleep). */
  pattern?: EventPattern
  /** Cron trigger; nextAt is maintained by the bus. */
  cron?: { expression: string; nextAt: number }
  /** waitFor timeout or sleep deadline. The bus fires with a null event. */
  expiresAt?: number
  createdAt: number
}

export type WorkflowTrigger =
  | { kind: 'cron'; expression: string }
  | { kind: 'event'; pattern: EventPattern }

export interface WorkflowBudget {
  /** Live agent() runs a single workflow run may start. */
  maxAgentRuns: number
  maxJudgeCalls: number
  maxNotifies: number
  /** Wall-clock ceiling for one run, waiting included. */
  maxRunHours: number
  /** Default per-agent-run ceiling; agent() options may lower it. */
  maxAgentMinutes: number
}

export const WORKFLOW_BUDGET_DEFAULTS: WorkflowBudget = {
  maxAgentRuns: 10,
  maxJudgeCalls: 20,
  maxNotifies: 5,
  maxRunHours: 72,
  maxAgentMinutes: 30
}

export type WorkflowOverlapPolicy = 'skip' | 'parallel'

/** What happens when an agent creates or edits a workflow: 'ask' (default)
 *  leaves it disabled until the user enables it — enabling is the approval —
 *  while 'auto' lets agent-authored workflows go live immediately, the same
 *  trust dial as auto vs ask permission modes. */
export type WorkflowApprovalMode = 'ask' | 'auto'

export interface WorkflowInput {
  name: string
  description?: string
  /** JavaScript source executed by the engine. Async; awaits allowed at top level. */
  script: string
  /** Absolute project path, or '' for a global workflow. */
  projectPath: string
  triggers: WorkflowTrigger[]
  overlapPolicy: WorkflowOverlapPolicy
  budget?: Partial<WorkflowBudget>
  /** Default agent settings a script call may override per step. */
  defaults?: {
    backendId?: BackendId
    model?: BackendModelPreference
    judgeBackendId?: BackendId
    judgeModel?: BackendModelPreference
  }
  keepRuns?: number
}

export interface Workflow extends WorkflowInput {
  id: string
  enabled: boolean
  source: 'user' | 'agent' | 'builtin'
  createdAt: number
  updatedAt: number
  lastRunAt?: number
}

export const WORKFLOW_DEFAULTS = {
  overlapPolicy: 'skip' as WorkflowOverlapPolicy,
  keepRuns: 100
}

export type JournalOp =
  | 'agent'
  | 'judge'
  | 'wait'
  | 'sleep'
  | 'notify'
  | 'ask'
  | 'state.get'
  | 'state.set'
  | 'pr'
  | 'log'

export type JournalStatus = 'started' | 'done' | 'failed'

export interface JournalEntry {
  seq: number
  op: JournalOp
  /** Stable hash of (op, args); a mismatch on replay means the script was
   *  edited and the journal is invalid from this entry on. */
  argsHash: string
  /** Clamped copy of the call arguments. Lets the engine re-perform a step
   *  interrupted by an app restart (fresh agent thread, re-registered wait)
   *  and lets the UI show pending asks without re-running the script. */
  args?: unknown
  /** Short human-readable label for run displays. */
  label?: string
  status: JournalStatus
  /** Live perform attempts, e.g. a judge retry after an unparseable verdict. */
  attempts?: number
  /** Live agent/judge conversation backing this entry. */
  threadId?: string
  worktreeId?: string
  /** JSON-safe primitive result, replayed on re-execution. */
  result?: unknown
  error?: string
  startedAt: number
  finishedAt?: number
}

export type WorkflowRunStatus =
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'skipped'
  | 'needs-attention'

export type WorkflowRunTrigger = 'cron' | 'event' | 'manual'

export interface WorkflowRunUsage {
  agentRuns: number
  judgeCalls: number
  notifies: number
}

export interface WorkflowRun {
  id: string
  workflowId: string
  /** Conversation that asked for this run; it gets the result as a message. */
  startedByThreadId?: string
  trigger: WorkflowRunTrigger
  status: WorkflowRunStatus
  /** The triggering event, exposed to the script as `event`. */
  event?: BossEvent
  journal: JournalEntry[]
  usage: WorkflowRunUsage
  /** JSON-safe script return value. */
  result?: unknown
  error?: string
  /** Engine annotations, e.g. a journal invalidation after a script edit. */
  note?: string
  startedAt: number
  finishedAt?: number
}

export interface WorkflowsSnapshot {
  workflows: Workflow[]
  runs: WorkflowRun[]
  approvalMode: WorkflowApprovalMode
}

/** Options a script may pass to agent(). */
export interface AgentCallOptions {
  backendId?: BackendId
  model?: BackendModelPreference
  mode?: BackendModeId
  workspace?: 'worktree' | 'project' | 'none'
  /** Run in the same checkout as a prior step's conversation (its threadId):
   *  how a reviewer reads an implementer's worktree, or a fix step edits it. */
  inWorktreeOf?: string
  maxMinutes?: number
  title?: string
}

/** What an agent() call resolves to inside a script. */
export interface AgentOutcome {
  status: 'success' | 'failure' | 'timeout' | 'aborted'
  summary?: string
  /** Last assistant message text, for scripts that parse structured output. */
  text?: string
  changedFiles: number
  threadId: string
  worktreeId?: string
  error?: string
}

export interface JudgeCallOptions {
  rubric?: string
  backendId?: BackendId
  model?: BackendModelPreference
}

export interface JudgeOutcome {
  verdict: string
  reason?: string
}

/** Final-line contract for judge() calls, mirroring the reviewer contract. */
export function judgePrompt(input: string, options: string[], rubric?: string): string {
  return [
    '[BOSS WORKFLOW JUDGE]',
    'You are a deterministic classifier inside an unattended workflow. Do not ask questions.',
    rubric ? `Rubric:\n${rubric}` : undefined,
    `Classify the input as exactly one of: ${options.join(', ')}`,
    'End your final message with exactly these two lines:',
    'REASON: <one sentence>',
    `VERDICT: <one of ${options.join(' | ')}>`,
    '',
    'Input:',
    input
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n')
}

/** Parse the judge contract from the model's final text. Returns null when
 *  the verdict line is missing or names an option that was not offered. */
export function parseJudgeOutcome(text: string | undefined, options: string[]): JudgeOutcome | null {
  if (!text) return null
  const lines = text.trim().split('\n')
  let verdict: string | undefined
  let reason: string | undefined
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 10; i -= 1) {
    const line = lines[i].trim()
    const verdictMatch = /^VERDICT:\s*(.+)$/i.exec(line)
    if (verdictMatch && !verdict) verdict = verdictMatch[1].trim()
    const reasonMatch = /^REASON:\s*(.+)$/i.exec(line)
    if (reasonMatch && !reason) reason = reasonMatch[1].trim()
  }
  if (!verdict) return null
  const matched = options.find((option) => option.toLowerCase() === verdict!.toLowerCase())
  if (!matched) return null
  return { verdict: matched, ...(reason ? { reason } : {}) }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}

/** Stable hash of a primitive call, used to detect script edits on replay.
 *  FNV-1a over the stable stringification; collisions only weaken edit
 *  detection, never correctness of results. */
export function hashArgs(op: string, args: unknown): string {
  const text = `${op} ${stableStringify(args)}`
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

const RESULT_CHAR_LIMIT = 32_000

/** Clamp a primitive result to a JSON-safe value bounded in size, so journals
 *  stay small and replay is exact. Long strings are truncated with a marker. */
export function clampResult(value: unknown): unknown {
  const seen = new WeakSet<object>()
  const clamp = (input: unknown, depth: number): unknown => {
    if (input === undefined || input === null) return input ?? null
    if (typeof input === 'string') {
      return input.length > RESULT_CHAR_LIMIT ? `${input.slice(0, RESULT_CHAR_LIMIT)}… [truncated]` : input
    }
    if (typeof input === 'number') return Number.isFinite(input) ? input : null
    if (typeof input === 'boolean') return input
    if (typeof input !== 'object' || depth > 8) return null
    if (seen.has(input as object)) return null
    seen.add(input as object)
    if (Array.isArray(input)) return input.slice(0, 500).map((item) => clamp(item, depth + 1))
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(input as Record<string, unknown>)) {
      if (item === undefined || typeof item === 'function') continue
      out[key] = clamp(item, depth + 1)
    }
    return out
  }
  return clamp(value, 0)
}
