import type { BackendModeId, BackendId } from './backend'
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
  /** Hidden from the default list. Lives on the thread, not in one window's
   *  localStorage, so every client agrees on what is visible. */
  archived?: boolean
  /** How much the agent may do without asking, when it has been set. */
  mode?: BackendModeId
  /** What this thread last ran on. A client changing only the thinking level
   *  still has to send a whole model, so it needs this to build one. */
  model?: { providerID: string; modelID: string; variant?: string }
  /** The thread this one was spawned from, when it was delegated. */
  parentID?: string
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
