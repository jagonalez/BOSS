import type { BackendId, BackendModelPreference } from './backend'

export type LabAssistantPullRequestState = 'open' | 'merged' | 'closed'
export type LabAssistantMergeability = 'clean' | 'conflicted' | 'unknown'
export type LabAssistantTaskStatus = 'inbox' | 'ready' | 'blocked' | 'running' | 'review' | 'done'
export type LabAssistantCiConclusion = 'failure' | 'timed_out' | 'action_required' | 'startup_failure' | 'success'

export interface LabAssistantAgentConfig {
  backendId: BackendId
  model?: BackendModelPreference
  instruction?: string
}

export interface LabAssistantWorkflowConfig {
  planner: LabAssistantAgentConfig
  implementer: LabAssistantAgentConfig
  reviewers: LabAssistantAgentConfig[]
  maxReviewCycles: number
}

export interface LabAssistantTask {
  id: string
  title: string
  details?: string
  /** Missing for work that spans projects. */
  projectPath?: string
  status: LabAssistantTaskStatus
  dependsOn: string[]
  assignedThreadId?: string
  /** The durable engine workflow driving this task's managed pipeline. */
  workflowId?: string
  createdAt: number
  updatedAt: number
  completedAt?: number
}

export interface LabAssistantTaskInput {
  title: string
  details?: string
  projectPath?: string
  dependsOn?: string[]
}

export interface LabAssistantTaskPatch {
  title?: string
  details?: string
  projectPath?: string | null
  status?: LabAssistantTaskStatus
  dependsOn?: string[]
}

export interface LabAssistantTaskPlan {
  mode: 'ordered' | 'parallel'
  taskIds: string[]
  updatedAt: number
}

export interface LabAssistantPullRequest {
  id: string
  repository: string
  number: number
  title: string
  url: string
  headBranch: string
  baseBranch: string
  state: LabAssistantPullRequestState
  mergeability: LabAssistantMergeability
  updatedAt: number
  conflictRoutedTo?: string
}

export interface LabAssistantCiJob {
  name: string
  url: string
  conclusion: string
  failedSteps: string[]
}

/** One workflow/branch failure episode. A later successful run resolves it;
 * another failure after that starts a fresh episode without losing history. */
export interface LabAssistantCiIncident {
  id: string
  repository: string
  workflowId: number
  workflow: string
  runId: number
  runNumber: number
  runAttempt: number
  url: string
  headBranch: string
  headSha: string
  pullRequestId?: string
  conclusion: LabAssistantCiConclusion
  status: 'failing' | 'resolved'
  jobs: LabAssistantCiJob[]
  occurrenceCount: number
  firstFailedAt: number
  updatedAt: number
  resolvedAt?: number
  taskId?: string
  routedTo?: string
  routedDeliveryKey?: string
  lastDeliveryKey: string
}

export interface LabAssistantQuestionOption {
  id: string
  label: string
}

export interface LabAssistantQuestion {
  id: string
  key: string
  repository: string
  prompt: string
  options: LabAssistantQuestionOption[]
  status: 'open' | 'answered' | 'dismissed'
  answerId?: string
  createdAt: number
  answeredAt?: number
  dismissedAt?: number
}

export interface LabAssistantActivity {
  id: string
  kind: 'pull-request' | 'ci' | 'agent-message' | 'decision' | 'task' | 'workflow'
  title: string
  detail: string
  repository?: string
  taskId?: string
  pullRequestId?: string
  ciIncidentId?: string
  workflowRunId?: string
  threadId?: string
  createdAt: number
}

export interface LabAssistantSnapshot {
  generatedAt: number
  tasks: LabAssistantTask[]
  /** Keyed by project path or "global". */
  taskPlans: Record<string, LabAssistantTaskPlan>
  pullRequests: LabAssistantPullRequest[]
  ciIncidents: LabAssistantCiIncident[]
  questions: LabAssistantQuestion[]
  activities: LabAssistantActivity[]
  /** Keyed by "owner/repo:base-branch". */
  mergeOrders: Record<string, string[]>
  workflowConfig?: LabAssistantWorkflowConfig
}
