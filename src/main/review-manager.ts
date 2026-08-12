import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import type {
  AddReviewCommentInput,
  PullRequestCheck,
  PullRequestReview,
  PullRequestFileDiff,
  PullRequestSummary,
  ReviewComment,
  ReviewSnapshot,
  SubmitReviewEvent
} from '@shared/review'

interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

interface StoredReviewState {
  version: 1
  comments: Record<string, ReviewComment[]>
}

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

function run(command: string, args: string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        code: error ? Number((error as NodeJS.ErrnoException).code) || 1 : 0,
        stdout: String(stdout),
        stderr: String(stderr)
      })
    })
  })
}

async function required(command: string, args: string[], cwd: string): Promise<string> {
  const result = await run(command, args, cwd)
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `${command} ${args[0]} failed`)
  return result.stdout
}

export function parseGitHubRemote(remote: string): string | undefined {
  const trimmed = remote.trim().replace(/\.git$/, '')
  const match = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https?:\/\/github\.com\/)([^/]+\/[^/]+)$/i.exec(trimmed)
  return match?.[1]
}

export function splitPullRequestDiff(value: string): PullRequestFileDiff[] {
  return value.split(/(?=^diff --git )/m).flatMap((block) => {
    if (!block.startsWith('diff --git ')) return []
    const pathMatch = /^\+\+\+ b\/(.+)$/m.exec(block)
    const fallback = /^diff --git a\/(.+?) b\/(.+)$/m.exec(block)
    const path = pathMatch?.[1] && pathMatch[1] !== '/dev/null' ? pathMatch[1] : fallback?.[2]
    return path && path !== '/dev/null' ? [{ path, patch: block }] : []
  })
}

function author(value?: GhAuthor | { login?: string; avatar_url?: string }): { login: string; avatarUrl?: string } {
  return {
    login: value?.login || 'unknown',
    avatarUrl: 'avatarUrl' in (value ?? {})
      ? (value as GhAuthor).avatarUrl
      : (value as { avatar_url?: string } | undefined)?.avatar_url
  }
}

function reviewComment(value: GhComment, source: 'github' | 'local' = 'github'): ReviewComment {
  const side = value.side ?? (value.line == null && value.original_line != null ? 'LEFT' : value.path ? 'RIGHT' : undefined)
  return {
    id: String(value.databaseId ?? value.id ?? randomUUID()),
    source,
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

function review(value: GhReview): PullRequestReview {
  return {
    id: String(value.databaseId ?? value.id ?? randomUUID()),
    author: author(value.author),
    body: value.body ?? '',
    state: value.state ?? 'COMMENTED',
    submittedAt: value.submittedAt,
    url: value.url
  }
}

export class ReviewManager {
  private state: StoredReviewState
  private readonly stateFile: string

  constructor(stateFile: string) {
    this.stateFile = stateFile
    this.state = this.load()
  }

  private load(): StoredReviewState {
    try {
      const parsed = JSON.parse(readFileSync(this.stateFile, 'utf8')) as StoredReviewState
      if (parsed.version === 1 && parsed.comments && typeof parsed.comments === 'object') return parsed
    } catch {
      /* A missing state file is normal. */
    }
    return { version: 1, comments: {} }
  }

  private save(): void {
    writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2))
  }

  private async repository(path: string): Promise<{ root: string; branch: string; remote?: string; github?: string }> {
    const root = (await required('git', ['rev-parse', '--show-toplevel'], path)).trim()
    const branch = (await required('git', ['branch', '--show-current'], root)).trim()
    const remoteResult = await run('git', ['remote', 'get-url', 'origin'], root)
    const remote = remoteResult.code === 0 ? remoteResult.stdout.trim() : undefined
    return { root, branch, remote, github: remote ? parseGitHubRemote(remote) : undefined }
  }

  private async githubSnapshot(root: string, repository: string): Promise<PullRequestSummary> {
    const fields = [
      'number', 'title', 'url', 'state', 'isDraft', 'author', 'baseRefName', 'baseRefOid',
      'headRefName', 'headRefOid', 'reviewDecision', 'mergeStateStatus', 'mergeable', 'comments', 'reviews'
    ].join(',')
    const raw = await required('gh', ['pr', 'view', '--json', fields], root)
    const pr = JSON.parse(raw) as GhPullRequest
    const inlineResult = await run('gh', ['api', `repos/${repository}/pulls/${pr.number}/comments?per_page=100`], root)
    const inline = inlineResult.code === 0 ? JSON.parse(inlineResult.stdout) as GhComment[] : []
    const checksResult = await run('gh', ['pr', 'checks', String(pr.number), '--json', 'name,state,bucket,link'], root)
    let checks: PullRequestCheck[] = []
    try {
      checks = (JSON.parse(checksResult.stdout || '[]') as Array<PullRequestCheck & { link?: string }>).map((check) => ({
        name: check.name,
        state: check.state,
        bucket: check.bucket,
        url: check.link
      }))
    } catch {
      checks = []
    }
    return {
      provider: 'github',
      repository,
      number: pr.number,
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
      comments: [...(pr.comments ?? []).map((comment) => reviewComment(comment)), ...inline.map((comment) => reviewComment(comment))]
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    }
  }

  async snapshot(path: string): Promise<ReviewSnapshot> {
    const repo = await this.repository(path)
    const base: ReviewSnapshot = {
      repositoryRoot: repo.root,
      branch: repo.branch,
      remoteUrl: repo.remote,
      provider: repo.github ? 'github' : repo.remote ? 'other' : 'none',
      providerLabel: repo.github ? 'GitHub' : repo.remote ? 'Git remote' : 'Local Git',
      localComments: this.state.comments[repo.root] ?? []
    }
    if (!repo.github) return base
    try {
      return { ...base, pullRequest: await this.githubSnapshot(repo.root, repo.github) }
    } catch (error) {
      return { ...base, syncError: error instanceof Error ? error.message : String(error) }
    }
  }

  async pullRequestDiff(path: string): Promise<PullRequestFileDiff[]> {
    const context = await this.githubContext(path)
    return splitPullRequestDiff(await required('gh', ['pr', 'diff', String(context.pullRequest.number), '--patch'], context.root))
  }

  async addLocal(path: string, input: AddReviewCommentInput): Promise<ReviewComment> {
    const repo = await this.repository(path)
    const body = input.body.trim()
    if (!body) throw new Error('A review comment is required.')
    const comment: ReviewComment = {
      id: randomUUID(),
      source: 'local',
      body,
      author: { login: 'You' },
      createdAt: new Date().toISOString(),
      file: input.file,
      line: input.line,
      side: input.side,
      pending: true,
      canDelete: true
    }
    this.state.comments[repo.root] = [...(this.state.comments[repo.root] ?? []), comment]
    this.save()
    return comment
  }

  async deleteLocal(path: string, commentId: string): Promise<boolean> {
    const repo = await this.repository(path)
    const before = this.state.comments[repo.root] ?? []
    const after = before.filter((comment) => comment.id !== commentId)
    if (after.length === before.length) return false
    this.state.comments[repo.root] = after
    this.save()
    return true
  }

  private async githubContext(path: string): Promise<{ root: string; repository: string; pullRequest: PullRequestSummary }> {
    const repo = await this.repository(path)
    if (!repo.github) throw new Error('This checkout is not connected to GitHub.')
    const pullRequest = await this.githubSnapshot(repo.root, repo.github)
    return { root: repo.root, repository: repo.github, pullRequest }
  }

  async publishComment(path: string, input: AddReviewCommentInput): Promise<ReviewSnapshot> {
    const context = await this.githubContext(path)
    const body = input.body.trim()
    if (!body) throw new Error('A review comment is required.')
    if (input.file && input.line && input.side) {
      await required('gh', [
        'api', '--method', 'POST', `repos/${context.repository}/pulls/${context.pullRequest.number}/comments`,
        '-f', `body=${body}`, '-f', `commit_id=${context.pullRequest.headRefOid}`, '-f', `path=${input.file}`,
        '-F', `line=${input.line}`, '-f', `side=${input.side}`
      ], context.root)
    } else {
      await required('gh', ['pr', 'comment', String(context.pullRequest.number), '--body', body], context.root)
    }
    return this.snapshot(context.root)
  }

  async reply(path: string, commentId: string, body: string): Promise<ReviewSnapshot> {
    const context = await this.githubContext(path)
    const clean = body.trim()
    if (!clean) throw new Error('A reply is required.')
    await required('gh', [
      'api', '--method', 'POST', `repos/${context.repository}/pulls/${context.pullRequest.number}/comments/${commentId}/replies`,
      '-f', `body=${clean}`
    ], context.root)
    return this.snapshot(context.root)
  }

  async submit(path: string, event: SubmitReviewEvent, body: string): Promise<ReviewSnapshot> {
    const context = await this.githubContext(path)
    if (event === 'REQUEST_CHANGES' && !body.trim()) throw new Error('A review summary is required when requesting changes.')
    const action = event === 'APPROVE' ? '--approve' : event === 'REQUEST_CHANGES' ? '--request-changes' : '--comment'
    const args = ['pr', 'review', String(context.pullRequest.number), action]
    if (body.trim()) args.push('--body', body.trim())
    await required('gh', args, context.root)
    return this.snapshot(context.root)
  }
}
