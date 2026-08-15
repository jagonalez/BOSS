export type ReviewLineSide = 'LEFT' | 'RIGHT'
export type ReviewCommentSource = 'local' | 'remote'
export type ReviewProviderId = string

export interface ReviewAuthor {
  login: string
  avatarUrl?: string
}

export interface ReviewComment {
  id: string
  source: ReviewCommentSource
  providerId?: ReviewProviderId
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

export interface ChangeRequestReview {
  id: string
  author: ReviewAuthor
  body: string
  state: string
  submittedAt?: string
  url?: string
}

export interface ChangeRequestCheck {
  name: string
  state: string
  bucket?: 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel'
  url?: string
}

export interface ReviewProviderCapabilities {
  canonicalDiff: boolean
  publishOverallComment: boolean
  publishInlineComment: boolean
  replyToComment: boolean
  submitVerdict: boolean
}

export interface ReviewProviderSummary {
  id: ReviewProviderId
  label: string
  changeRequestLabel: string
  capabilities: ReviewProviderCapabilities
}

export interface ChangeRequestSummary {
  providerId: ReviewProviderId
  repository: string
  id: string
  displayId: string
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
  checks: ChangeRequestCheck[]
  reviews: ChangeRequestReview[]
  comments: ReviewComment[]
}

export interface ReviewSnapshot {
  repositoryRoot: string
  branch: string
  remoteUrl?: string
  provider?: ReviewProviderSummary
  changeRequest?: ChangeRequestSummary
  localComments: ReviewComment[]
  /** The branch has no pull request yet. Not a failure: it is what every
   *  branch looks like until someone opens one, so it is kept apart from
   *  syncError, which means the lookup itself went wrong. */
  awaitingChangeRequest?: boolean
  syncError?: string
}

export interface ChangeRequestFileDiff {
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
