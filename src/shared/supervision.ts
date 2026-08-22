import type { BackendId } from './backend'
import type { TaskPolicy, TaskPolicyState } from './task-policy'

export type RunStatus = 'running' | 'completed' | 'error' | 'interrupted'
export type AttentionKind = 'permission' | 'question' | 'completed' | 'error' | 'interrupted'

export interface ThreadAttention {
  kind: AttentionKind
  createdAt: number
  detail?: string
}

export interface RunMetrics {
  status: RunStatus
  startedAt: number
  finishedAt?: number
  durationMs: number
  tokens?: number
  toolCalls: number
}

export interface ThreadUsageTotals {
  runs: number
  durationMs: number
  tokens?: number
  tokenRuns: number
  toolCalls: number
}

/** Usage BOSS has observed for one backend subscription or selected agent.
 *
 * These are activity totals, not a provider's billing or rate-limit balance:
 * provider CLIs do not expose that consistently, while BOSS can report every
 * run it has actually supervised. */
export interface UsageBreakdown {
  backendId: BackendId
  /** Omitted for the backend's standard agent. */
  agentId?: string
  usage: ThreadUsageTotals
}

export type LineageKind = 'fork' | 'clone' | 'relay' | 'delegate' | 'review' | 'fallback'

export interface ThreadLineage {
  kind: LineageKind
  sourceThreadId: string
  sourceBackendId?: BackendId
}

/** What a thread produced when its run finished.
 *
 *  Captured once, when the run settles, rather than derived on demand: the
 *  diff it counts is the diff as it stood at that moment, and a later run
 *  would report a different one. */
export interface ThreadResult {
  summary?: string
  changedFiles: number
  branch?: string
  finishedAt: number
  status: RunStatus
}

export interface SupervisedThread {
  threadId: string
  backendId: BackendId
  title: string
  projectPath: string
  executionPath: string
  updatedAt: number
  worktreeBranch?: string
  running: boolean
  attention?: ThreadAttention
  lastRun?: RunMetrics
  usage: ThreadUsageTotals
  policy?: TaskPolicy
  /** Where this thread came from. The manager has always recorded it on the
   *  binding; carrying it here is what lets a surface nest a delegated worker
   *  under the thread that created it instead of listing both as peers. */
  lineage?: ThreadLineage
  /** What the thread's last finished run produced. */
  result?: ThreadResult
  /** What the task policy has actually done: which reviewers ran and how they
   *  answered. Recorded since reviewers were wired, but without this no surface
   *  could show a verdict without opening the reviewer's own thread. */
  policyState?: TaskPolicyState
}

export interface SupervisionSnapshot {
  generatedAt: number
  threads: SupervisedThread[]
  totals: ThreadUsageTotals
  /** One row per backend subscription BOSS has used. */
  usageByBackend: UsageBreakdown[]
  /** One row per selected agent, including each backend's standard agent. */
  usageByAgent: UsageBreakdown[]
}

export interface TranscriptSearchResult {
  threadId: string
  messageId: string
  backendId: BackendId
  title: string
  projectPath: string
  role: 'user' | 'assistant'
  kind: 'message' | 'reasoning' | 'tool'
  snippet: string
  timestamp?: number
}
