import type { BackendId, BackendModeId, BackendModelPreference } from './backend'

// The event list and its type live beside the trigger logic in
// automation-trigger.ts; re-exported here so config consumers have one module.
import type { AutomationWebhookEvent } from './automation-trigger'
export type { AutomationWebhookEvent } from './automation-trigger'

export type AutomationWorkspace = 'worktree' | 'project' | 'none'
export type AutomationOverlapPolicy = 'skip' | 'queue'
export type AutomationRunTrigger = 'schedule' | 'manual' | 'catch-up' | 'webhook'
export type AutomationRunStatus = 'running' | 'success' | 'failure' | 'timeout' | 'skipped' | 'aborted'
/** off = never notify; events = failures, timeouts, and runs that change files; always = every finished run. */
export type AutomationNotifyMode = 'off' | 'events' | 'always'

export interface AutomationSchedule {
  kind: 'cron' | 'manual'
  /** Five-field cron expression, evaluated in local time. Present when kind is 'cron'. */
  expression?: string
}

/**
 * Fires the automation when GitHub delivers one of these events to BOSS's
 * built-in hook endpoint. The per-automation secret lives in the manager's
 * state file rather than on this config, so snapshots broadcast to phones and
 * the relay never carry it.
 */
export interface AutomationWebhookTrigger {
  /** GitHub events that may fire this automation. Empty means any supported event. */
  events: AutomationWebhookEvent[]
  /** Fire only for pushes to — or pull requests targeting — this branch. Empty means any branch. */
  branch?: string
}

export interface AutomationInput {
  name: string
  prompt: string
  /** Absolute project path, or '' for a projectless (global) automation. */
  projectPath: string
  backendId: BackendId
  model?: BackendModelPreference
  mode: BackendModeId
  schedule: AutomationSchedule
  /** GitHub webhook trigger. Absent or null means the automation has no webhook. */
  webhook?: AutomationWebhookTrigger | null
  workspace: AutomationWorkspace
  overlapPolicy: AutomationOverlapPolicy
  catchUp: boolean
  notify: AutomationNotifyMode
  maxRunMinutes: number
  keepRuns: number
}

export interface Automation extends AutomationInput {
  id: string
  enabled: boolean
  nextRunAt?: number
  lastRunAt?: number
  lastWebhookAt?: number
  /** Human-readable summary of the most recent delivery, e.g. "push · octo/hello · main". */
  lastWebhookLabel?: string
  missedRuns: number
  createdAt: number
  updatedAt: number
}

export interface AutomationRun {
  id: string
  automationId: string
  /** Durable presentation copy of this run's final answer, when one exists. */
  reportId?: string
  threadId?: string
  worktreeId?: string
  trigger: AutomationRunTrigger
  status: AutomationRunStatus
  summary?: string
  error?: string
  needsAttention?: boolean
  changedFiles: number
  startedAt: number
  finishedAt?: number
}

export interface AutomationsSnapshot {
  automations: Automation[]
  runs: AutomationRun[]
}

export const AUTOMATION_DEFAULTS = {
  mode: 'auto' as BackendModeId,
  workspace: 'worktree' as AutomationWorkspace,
  overlapPolicy: 'skip' as AutomationOverlapPolicy,
  catchUp: true,
  notify: 'events' as AutomationNotifyMode,
  maxRunMinutes: 30,
  keepRuns: 50
}
