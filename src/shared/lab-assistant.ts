export type LabAssistantPullRequestState = 'open' | 'merged' | 'closed'
export type LabAssistantMergeability = 'clean' | 'conflicted' | 'unknown'

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
  status: 'open' | 'answered'
  answerId?: string
  createdAt: number
  answeredAt?: number
}

export interface LabAssistantActivity {
  id: string
  kind: 'pull-request' | 'agent-message' | 'decision'
  title: string
  detail: string
  repository?: string
  pullRequestId?: string
  threadId?: string
  createdAt: number
}

export interface LabAssistantSnapshot {
  generatedAt: number
  pullRequests: LabAssistantPullRequest[]
  questions: LabAssistantQuestion[]
  activities: LabAssistantActivity[]
  /** Keyed by "owner/repo:base-branch". */
  mergeOrders: Record<string, string[]>
}
