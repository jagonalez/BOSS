import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import type {
  AddReviewCommentInput,
  ChangeRequestFileDiff,
  ChangeRequestSummary,
  ReviewComment,
  ReviewSnapshot,
  SubmitReviewEvent
} from '@shared/review'
// The explicit extensions keep the source executable under Node's type-stripping test runner.
import type { ReviewProvider, ReviewProviderMatch, ReviewRepository } from './review-provider.ts'
// @ts-expect-error Application builds use bundler resolution.
import { requiredCommand, runCommand } from './review-provider.ts'
// @ts-expect-error Application builds use bundler resolution.
import { ChangeRequestCache, changeRequestKey } from './change-request-cache.ts'

interface StoredReviewState {
  version: 1
  comments: Record<string, ReviewComment[]>
}

/** Tell "you have not opened one yet" apart from "the lookup broke".
 *
 *  Both arrive as a non-zero exit from the provider CLI, but only one is worth
 *  interrupting someone over. Matching the message is unpleasant and will need
 *  revisiting if a provider rewords it; the alternative is showing a warning to
 *  everyone who has ever pushed a branch before opening a pull request. */
export function noChangeRequestYet(message: string): boolean {
  return /\bno (?:pull requests?|merge requests?) found\b/i.test(message)
}

interface ProviderContext {
  repository: ReviewRepository
  provider: ReviewProvider
  match: ReviewProviderMatch
  changeRequest: ChangeRequestSummary
}

export class ReviewManager {
  private state: StoredReviewState
  private readonly stateFile: string
  private readonly providers: ReviewProvider[]
  private readonly changeRequests: ChangeRequestCache

  constructor(stateFile: string, providers: ReviewProvider[] = [], changeRequests = new ChangeRequestCache()) {
    this.stateFile = stateFile
    this.providers = providers
    this.changeRequests = changeRequests
    this.state = this.load()
  }

  /** Forget a branch's change request, so the next look is a fresh one.
   *  Publishing or submitting changes the pull request we just cached. */
  private forgetChangeRequest(repository: ReviewRepository): void {
    this.changeRequests.invalidate(changeRequestKey(repository.root, repository.branch))
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

  private async repository(path: string): Promise<ReviewRepository> {
    const root = (await requiredCommand('git', ['rev-parse', '--show-toplevel'], path)).trim()
    const branch = (await requiredCommand('git', ['branch', '--show-current'], root)).trim()
    const remoteResult = await runCommand('git', ['remote', 'get-url', 'origin'], root)
    const remoteUrl = remoteResult.code === 0 ? remoteResult.stdout.trim() : undefined
    return { root, branch, remoteUrl }
  }

  private providerFor(repository: ReviewRepository): { provider: ReviewProvider; match: ReviewProviderMatch } | undefined {
    if (!repository.remoteUrl) return undefined
    for (const provider of this.providers) {
      const match = provider.match(repository.remoteUrl)
      if (match) return { provider, match }
    }
    return undefined
  }

  async snapshot(path: string): Promise<ReviewSnapshot> {
    const repository = await this.repository(path)
    const selected = this.providerFor(repository)
    const base: ReviewSnapshot = {
      repositoryRoot: repository.root,
      branch: repository.branch,
      remoteUrl: repository.remoteUrl,
      provider: selected?.provider.summary,
      localComments: this.state.comments[repository.root] ?? []
    }
    if (!selected) return base
    try {
      const changeRequest = await this.changeRequestFor(repository, selected)
      return changeRequest ? { ...base, changeRequest } : { ...base, awaitingChangeRequest: true }
    } catch (error) {
      return { ...base, syncError: error instanceof Error ? error.message : String(error) }
    }
  }

  /** The branch's change request, looked up once and shared.
   *
   *  Several threads can sit on one branch, and the sidebar asks for the same
   *  branch the review tab already has. Undefined means the branch has no
   *  change request, which is cached like any other answer. */
  private async changeRequestFor(
    repository: ReviewRepository,
    selected: { provider: ReviewProvider; match: ReviewProviderMatch }
  ): Promise<ChangeRequestSummary | undefined> {
    return this.changeRequests.get(changeRequestKey(repository.root, repository.branch), async () => {
      try {
        return await selected.provider.getChangeRequest(repository, selected.match)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // A branch with no change request is an answer, not a failure, so it
        // is cached. Anything else is rethrown and left uncached.
        if (noChangeRequestYet(message)) return undefined
        throw error
      }
    })
  }

  private async providerContext(path: string): Promise<ProviderContext> {
    const repository = await this.repository(path)
    const selected = this.providerFor(repository)
    if (!selected) throw new Error('No remote review provider is configured for this checkout.')
    const changeRequest = await this.changeRequestFor(repository, selected)
    // Everything reaching here publishes to a change request, so there has to
    // be one. Saying which branch beats the provider's own wording, which reads
    // like a failure rather than "open one first".
    if (!changeRequest) {
      throw new Error(`No ${selected.provider.summary.changeRequestLabel.toLowerCase()} is open for ${repository.branch}.`)
    }
    return { repository, ...selected, changeRequest }
  }

  async changeRequestDiff(path: string): Promise<ChangeRequestFileDiff[]> {
    const context = await this.providerContext(path)
    if (!context.provider.summary.capabilities.canonicalDiff || !context.provider.getCanonicalDiff) {
      throw new Error(`${context.provider.summary.label} does not provide a canonical review diff.`)
    }
    return context.provider.getCanonicalDiff(context.repository, context.match, context.changeRequest)
  }

  async addLocal(path: string, input: AddReviewCommentInput): Promise<ReviewComment> {
    const repository = await this.repository(path)
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
    this.state.comments[repository.root] = [...(this.state.comments[repository.root] ?? []), comment]
    this.save()
    return comment
  }

  async deleteLocal(path: string, commentId: string): Promise<boolean> {
    const repository = await this.repository(path)
    const before = this.state.comments[repository.root] ?? []
    const after = before.filter((comment) => comment.id !== commentId)
    if (after.length === before.length) return false
    this.state.comments[repository.root] = after
    this.save()
    return true
  }

  async publishComment(path: string, input: AddReviewCommentInput): Promise<ReviewSnapshot> {
    const context = await this.providerContext(path)
    const capability = input.file
      ? context.provider.summary.capabilities.publishInlineComment
      : context.provider.summary.capabilities.publishOverallComment
    if (!capability || !context.provider.publishComment) throw new Error(`${context.provider.summary.label} does not support this kind of review comment.`)
    await context.provider.publishComment(context.repository, context.match, context.changeRequest, input)
    this.forgetChangeRequest(context.repository)
    return this.snapshot(context.repository.root)
  }

  async reply(path: string, commentId: string, body: string): Promise<ReviewSnapshot> {
    const context = await this.providerContext(path)
    if (!context.provider.summary.capabilities.replyToComment || !context.provider.replyToComment) {
      throw new Error(`${context.provider.summary.label} does not support review replies.`)
    }
    await context.provider.replyToComment(context.repository, context.match, context.changeRequest, commentId, body)
    this.forgetChangeRequest(context.repository)
    return this.snapshot(context.repository.root)
  }

  async submit(path: string, event: SubmitReviewEvent, body: string): Promise<ReviewSnapshot> {
    const context = await this.providerContext(path)
    if (!context.provider.summary.capabilities.submitVerdict || !context.provider.submitVerdict) {
      throw new Error(`${context.provider.summary.label} does not support review verdicts.`)
    }
    await context.provider.submitVerdict(context.repository, context.match, context.changeRequest, event, body)
    this.forgetChangeRequest(context.repository)
    return this.snapshot(context.repository.root)
  }
}
