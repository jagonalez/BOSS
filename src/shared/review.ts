export type ReviewLineSide = 'LEFT' | 'RIGHT'
export type ReviewCommentSource = 'local' | 'github'

export interface ReviewAuthor {
  login: string
  avatarUrl?: string
}

export interface ReviewComment {
  id: string
  source: ReviewCommentSource
  body: string
  author: ReviewAuthor
  createdAt: string
  updatedAt?: string
  url?: string
  file?: string
  line?: number
  side?: ReviewLineSide
  diffHunk?: string
  replyToId?: string
  pending?: boolean
  canDelete?: boolean
}

export interface PullRequestReview {
  id: string
  author: ReviewAuthor
  body: string
  state: string
  submittedAt?: string
  url?: string
}

export interface PullRequestCheck {
  name: string
  state: string
  bucket?: 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel'
  url?: string
}

export interface PullRequestSummary {
  provider: 'github'
  repository: string
  number: number
  title: string
  url: string
  state: string
  isDraft: boolean
  author: ReviewAuthor
  baseRefName: string
  baseRefOid: string
  headRefName: string
  headRefOid: string
  reviewDecision?: string
  mergeStateStatus?: string
  mergeable?: string
  checks: PullRequestCheck[]
  reviews: PullRequestReview[]
  comments: ReviewComment[]
}

export interface ReviewSnapshot {
  repositoryRoot: string
  branch: string
  remoteUrl?: string
  provider: 'github' | 'other' | 'none'
  providerLabel?: string
  pullRequest?: PullRequestSummary
  localComments: ReviewComment[]
  syncError?: string
}

export interface PullRequestFileDiff {
  path: string
  patch: string
}

export interface AddReviewCommentInput {
  body: string
  file?: string
  line?: number
  side?: ReviewLineSide
}

export type SubmitReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'
