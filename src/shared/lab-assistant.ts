export type LabAssistantPullRequestState = 'open' | 'merged' | 'closed'
export type LabAssistantMergeability = 'clean' | 'conflicted' | 'unknown'
export type LabAssistantTaskStatus = 'inbox' | 'ready' | 'blocked' | 'running' | 'review' | 'done'

export interface LabAssistantTask {
  id: string
  title: string
  details?: string
  /** Missing for work that spans projects. */
  projectPath?: string
  status: LabAssistantTaskStatus
  dependsOn: string[]
  assignedThreadId?: string
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
  kind: 'pull-request' | 'agent-message' | 'decision' | 'task'
  title: string
  detail: string
  repository?: string
  taskId?: string
  pullRequestId?: string
  threadId?: string
  createdAt: number
}

export interface LabAssistantSnapshot {
  generatedAt: number
  tasks: LabAssistantTask[]
  /** Keyed by project path or "global". */
  taskPlans: Record<string, LabAssistantTaskPlan>
  pullRequests: LabAssistantPullRequest[]
  questions: LabAssistantQuestion[]
  activities: LabAssistantActivity[]
  /** Keyed by "owner/repo:base-branch". */
  mergeOrders: Record<string, string[]>
}
