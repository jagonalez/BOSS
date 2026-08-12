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
