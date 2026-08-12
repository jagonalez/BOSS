import type { BackendId, BackendModeId, BackendModelPreference } from './backend'

export type AutomationWorkspace = 'worktree' | 'project' | 'none'
export type AutomationOverlapPolicy = 'skip' | 'queue'
export type AutomationRunTrigger = 'schedule' | 'manual' | 'catch-up'
export type AutomationRunStatus = 'running' | 'success' | 'failure' | 'timeout' | 'skipped' | 'aborted'

export interface AutomationSchedule {
  kind: 'cron' | 'manual'
  /** Five-field cron expression, evaluated in local time. Present when kind is 'cron'. */
  expression?: string
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
  workspace: AutomationWorkspace
  overlapPolicy: AutomationOverlapPolicy
  catchUp: boolean
  notify: boolean
  maxRunMinutes: number
  keepRuns: number
}

export interface Automation extends AutomationInput {
  id: string
  enabled: boolean
  nextRunAt?: number
  lastRunAt?: number
  missedRuns: number
  createdAt: number
  updatedAt: number
}

export interface AutomationRun {
  id: string
  automationId: string
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
  notify: true,
  maxRunMinutes: 30,
  keepRuns: 50
}
