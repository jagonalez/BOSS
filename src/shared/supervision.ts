import type { BackendId } from './backend'
import type { TaskPolicy } from './task-policy'

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
  lastRun?: RunMetrics
  usage: ThreadUsageTotals
  policy?: TaskPolicy
  /** Where this thread came from. The manager has always recorded it on the
   *  binding; carrying it here is what lets a surface nest a delegated worker
   *  under the thread that created it instead of listing both as peers. */
  lineage?: ThreadLineage
  /** What the thread's last finished run produced. */
  result?: ThreadResult
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
