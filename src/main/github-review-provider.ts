import { randomUUID } from 'node:crypto'
import type {
  AddReviewCommentInput,
  ChangeRequestCheck,
  ChangeRequestFileDiff,
  ChangeRequestReview,
  ChangeRequestSummary,
  ReviewAuthor,
  ReviewComment,
  SubmitReviewEvent
} from '@shared/review'
// The explicit extension keeps the source executable under Node's type-stripping test runner.
import type { ReviewProvider, ReviewProviderMatch, ReviewRepository } from './review-provider.ts'
// @ts-expect-error Application builds use bundler resolution.
import { requiredCommand, runCommand } from './review-provider.ts'

interface GhAuthor { login?: string; avatarUrl?: string }
interface GhComment {
  id?: string | number
  databaseId?: string | number
  body?: string
  author?: GhAuthor
  user?: { login?: string; avatar_url?: string }
  createdAt?: string
  created_at?: string
  updatedAt?: string
  updated_at?: string
  url?: string
  html_url?: string
  path?: string
  line?: number | null
  original_line?: number | null
  side?: 'LEFT' | 'RIGHT'
  diff_hunk?: string
  in_reply_to_id?: number
}

interface GhReview {
  id?: string
  databaseId?: string | number
  author?: GhAuthor
  body?: string
  state?: string
  submittedAt?: string
  url?: string
}

interface GhPullRequest {
  number: number
  title: string
  url: string
  state: string
  isDraft: boolean
  author?: GhAuthor
  baseRefName: string
  baseRefOid: string
  headRefName: string
  headRefOid: string
  reviewDecision?: string
  mergeStateStatus?: string
  mergeable?: string
  comments?: GhComment[]
  reviews?: GhReview[]
}

export function parseGitHubRemote(remote: string): string | undefined {
  const trimmed = remote.trim().replace(/\.git$/, '')
  const match = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https?:\/\/github\.com\/)([^/]+\/[^/]+)$/i.exec(trimmed)
  return match?.[1]
}

export function splitGitHubPullRequestDiff(value: string): ChangeRequestFileDiff[] {
  return value.split(/(?=^diff --git )/m).flatMap((block) => {
    if (!block.startsWith('diff --git ')) return []
    const pathMatch = /^\+\+\+ b\/(.+)$/m.exec(block)
    const fallback = /^diff --git a\/(.+?) b\/(.+)$/m.exec(block)
    const path = pathMatch?.[1] && pathMatch[1] !== '/dev/null' ? pathMatch[1] : fallback?.[2]
    return path && path !== '/dev/null' ? [{ path, patch: block }] : []
  })
}

function author(value?: GhAuthor | { login?: string; avatar_url?: string }): ReviewAuthor {
  return {
    login: value?.login || 'unknown',
    avatarUrl: 'avatarUrl' in (value ?? {})
      ? (value as GhAuthor).avatarUrl
      : (value as { avatar_url?: string } | undefined)?.avatar_url
  }
}

function reviewComment(value: GhComment): ReviewComment {
  const side = value.side ?? (value.line == null && value.original_line != null ? 'LEFT' : value.path ? 'RIGHT' : undefined)
  return {
    id: String(value.databaseId ?? value.id ?? randomUUID()),
    source: 'remote',
    providerId: 'github',
    body: value.body ?? '',
    author: author(value.author ?? value.user),
    createdAt: value.createdAt ?? value.created_at ?? new Date().toISOString(),
    updatedAt: value.updatedAt ?? value.updated_at,
    url: value.url ?? value.html_url,
    file: value.path,
    line: value.line ?? value.original_line ?? undefined,
    side,
    diffHunk: value.diff_hunk,
    replyToId: value.in_reply_to_id === undefined ? undefined : String(value.in_reply_to_id)
  }
}

function review(value: GhReview): ChangeRequestReview {
  return {
    id: String(value.databaseId ?? value.id ?? randomUUID()),
    author: author(value.author),
    body: value.body ?? '',
    state: value.state ?? 'COMMENTED',
    submittedAt: value.submittedAt,
    url: value.url
  }
}

export class GitHubReviewProvider implements ReviewProvider {
  readonly summary = {
    id: 'github',
    label: 'GitHub',
    changeRequestLabel: 'Pull request',
    capabilities: {
      canonicalDiff: true,
      publishOverallComment: true,
      publishInlineComment: true,
      replyToComment: true,
      submitVerdict: true
    }
  } as const

  match(remoteUrl: string): ReviewProviderMatch | undefined {
    const repository = parseGitHubRemote(remoteUrl)
    return repository ? { repository } : undefined
  }

  async getChangeRequest(repository: ReviewRepository, match: ReviewProviderMatch): Promise<ChangeRequestSummary> {
    const fields = [
      'number', 'title', 'url', 'state', 'isDraft', 'author', 'baseRefName', 'baseRefOid',
      'headRefName', 'headRefOid', 'reviewDecision', 'mergeStateStatus', 'mergeable', 'comments', 'reviews'
    ].join(',')
    const raw = await requiredCommand('gh', ['pr', 'view', '--json', fields], repository.root)
    const pr = JSON.parse(raw) as GhPullRequest
    const inlineResult = await runCommand('gh', ['api', `repos/${match.repository}/pulls/${pr.number}/comments?per_page=100`], repository.root)
    const inline = inlineResult.code === 0 ? JSON.parse(inlineResult.stdout) as GhComment[] : []
    const checksResult = await runCommand('gh', ['pr', 'checks', String(pr.number), '--json', 'name,state,bucket,link'], repository.root)
    let checks: ChangeRequestCheck[] = []
    try {
      checks = (JSON.parse(checksResult.stdout || '[]') as Array<ChangeRequestCheck & { link?: string }>).map((check) => ({
        name: check.name,
        state: check.state,
        bucket: check.bucket,
        url: check.link
      }))
    } catch {
      checks = []
    }
    return {
      providerId: this.summary.id,
      repository: match.repository,
      id: String(pr.number),
      displayId: `#${pr.number}`,
      title: pr.title,
      url: pr.url,
      state: pr.state,
      isDraft: pr.isDraft,
      author: author(pr.author),
      baseRefName: pr.baseRefName,
      baseRefOid: pr.baseRefOid,
      headRefName: pr.headRefName,
      headRefOid: pr.headRefOid,
      reviewDecision: pr.reviewDecision,
      mergeStateStatus: pr.mergeStateStatus,
      mergeable: pr.mergeable,
      checks,
      reviews: (pr.reviews ?? []).map(review),
      comments: [...(pr.comments ?? []).map(reviewComment), ...inline.map(reviewComment)]
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    }
  }

  async getCanonicalDiff(repository: ReviewRepository, _match: ReviewProviderMatch, changeRequest: ChangeRequestSummary): Promise<ChangeRequestFileDiff[]> {
    return splitGitHubPullRequestDiff(await requiredCommand('gh', ['pr', 'diff', changeRequest.id, '--patch'], repository.root))
  }

  async publishComment(repository: ReviewRepository, match: ReviewProviderMatch, changeRequest: ChangeRequestSummary, input: AddReviewCommentInput): Promise<void> {
    const body = input.body.trim()
    if (!body) throw new Error('A review comment is required.')
    if (input.file && input.line && input.side) {
      await requiredCommand('gh', [
        'api', '--method', 'POST', `repos/${match.repository}/pulls/${changeRequest.id}/comments`,
        '-f', `body=${body}`, '-f', `commit_id=${changeRequest.headRefOid}`, '-f', `path=${input.file}`,
        '-F', `line=${input.line}`, '-f', `side=${input.side}`
      ], repository.root)
    } else {
      await requiredCommand('gh', ['pr', 'comment', changeRequest.id, '--body', body], repository.root)
    }
  }

  async replyToComment(repository: ReviewRepository, match: ReviewProviderMatch, changeRequest: ChangeRequestSummary, commentId: string, body: string): Promise<void> {
    const clean = body.trim()
    if (!clean) throw new Error('A reply is required.')
    await requiredCommand('gh', [
      'api', '--method', 'POST', `repos/${match.repository}/pulls/${changeRequest.id}/comments/${commentId}/replies`,
      '-f', `body=${clean}`
    ], repository.root)
  }

  async submitVerdict(repository: ReviewRepository, _match: ReviewProviderMatch, changeRequest: ChangeRequestSummary, event: SubmitReviewEvent, body: string): Promise<void> {
    if (event === 'REQUEST_CHANGES' && !body.trim()) throw new Error('A review summary is required when requesting changes.')
    const action = event === 'APPROVE' ? '--approve' : event === 'REQUEST_CHANGES' ? '--request-changes' : '--comment'
    const args = ['pr', 'review', changeRequest.id, action]
    if (body.trim()) args.push('--body', body.trim())
    await requiredCommand('gh', args, repository.root)
  }
}
