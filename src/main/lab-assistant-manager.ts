import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import type { GitHubDelivery } from '../shared/automation-trigger'
import type {
  LabAssistantActivity,
  LabAssistantMergeability,
  LabAssistantPullRequest,
  LabAssistantQuestion,
  LabAssistantSnapshot
} from '../shared/lab-assistant'
import type { BossEvent } from '../shared/notification'
import type { SupervisedThread } from '../shared/supervision'

interface StoredLabAssistantState {
  version: 1
  pullRequests: LabAssistantPullRequest[]
  questions: LabAssistantQuestion[]
  activities: LabAssistantActivity[]
  mergeOrders: Record<string, string[]>
}

export interface LabAssistantHost {
  threads(): SupervisedThread[]
  messageAgent(threadId: string, message: string): Promise<void>
  refreshPullRequests?(repository: string): Promise<LabAssistantPullRequest[]>
  emit(snapshot: LabAssistantSnapshot): void
  notify(event: BossEvent): void
}

const ACTIVITY_CAP = 100

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function pullRequestFromDelivery(delivery: GitHubDelivery, now: number): LabAssistantPullRequest | undefined {
  if (delivery.event !== 'pull_request') return undefined
  const body = delivery.body
  const pullRequest = record(body.pull_request)
  const repository = text(record(body.repository).full_name)
  const number = typeof body.number === 'number' ? body.number : Number(body.number)
  if (!repository || !Number.isInteger(number) || number <= 0) return undefined
  const headBranch = text(record(pullRequest.head).ref)
  const baseBranch = text(record(pullRequest.base).ref)
  if (!headBranch || !baseBranch) return undefined
  const action = delivery.action ?? ''
  const merged = pullRequest.merged === true
  const state = action === 'closed' ? (merged ? 'merged' : 'closed') : 'open'
  const mergeableState = text(pullRequest.mergeable_state).toLowerCase()
  let mergeability: LabAssistantMergeability = 'unknown'
  if (pullRequest.mergeable === false || ['dirty', 'conflicting'].includes(mergeableState)) mergeability = 'conflicted'
  else if (pullRequest.mergeable === true || ['clean', 'has_hooks', 'unstable'].includes(mergeableState)) mergeability = 'clean'
  return {
    id: `${repository}#${number}`,
    repository,
    number,
    title: text(pullRequest.title) || `Pull request #${number}`,
    url: text(pullRequest.html_url),
    headBranch,
    baseBranch,
    state,
    mergeability,
    updatedAt: now
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

export class LabAssistantManager {
  private readonly stateFile: string
  private readonly host: LabAssistantHost
  private readonly clock: () => number
  private loaded = false
  private pullRequests: LabAssistantPullRequest[] = []
  private questions: LabAssistantQuestion[] = []
  private activities: LabAssistantActivity[] = []
  private mergeOrders: Record<string, string[]> = {}
  private pendingMutation: Promise<void> = Promise.resolve()

  constructor(stateFile: string, host: LabAssistantHost, clock: () => number = Date.now) {
    this.stateFile = stateFile
    this.host = host
    this.clock = clock
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed = JSON.parse(await readFile(this.stateFile, 'utf8')) as Partial<StoredLabAssistantState>
      if (parsed.version !== 1) return
      if (Array.isArray(parsed.pullRequests)) this.pullRequests = parsed.pullRequests
      if (Array.isArray(parsed.questions)) this.questions = parsed.questions
      if (Array.isArray(parsed.activities)) this.activities = parsed.activities.slice(0, ACTIVITY_CAP)
      if (parsed.mergeOrders && typeof parsed.mergeOrders === 'object') this.mergeOrders = parsed.mergeOrders
    } catch {
      /* First launch or a corrupt optional state file starts empty. */
    }
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.stateFile), { recursive: true })
    const state: StoredLabAssistantState = {
      version: 1,
      pullRequests: this.pullRequests,
      questions: this.questions,
      activities: this.activities,
      mergeOrders: this.mergeOrders
    }
    await writeFile(this.stateFile, JSON.stringify(state, null, 2))
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pendingMutation.then(operation, operation)
    this.pendingMutation = result.then(() => undefined, () => undefined)
    return result
  }

  private currentSnapshot(): LabAssistantSnapshot {
    return {
      generatedAt: this.clock(),
      pullRequests: clone(this.pullRequests),
      questions: clone(this.questions),
      activities: clone(this.activities),
      mergeOrders: clone(this.mergeOrders)
    }
  }

  async start(): Promise<void> {
    await this.load()
    this.host.emit(this.currentSnapshot())
  }

  async snapshot(): Promise<LabAssistantSnapshot> {
    await this.pendingMutation
    await this.load()
    return this.currentSnapshot()
  }

  private addActivity(activity: Omit<LabAssistantActivity, 'id' | 'createdAt'>): void {
    this.activities.unshift({ id: randomUUID(), createdAt: this.clock(), ...activity })
    this.activities = this.activities.slice(0, ACTIVITY_CAP)
  }

  private addQuestion(input: Omit<LabAssistantQuestion, 'id' | 'status' | 'createdAt'>): LabAssistantQuestion {
    const existing = this.questions.find((question) => question.key === input.key)
    if (existing?.status === 'open') return existing
    if (existing) {
      existing.prompt = input.prompt
      existing.options = input.options
      existing.status = 'open'
      existing.createdAt = this.clock()
      delete existing.answerId
      delete existing.answeredAt
      this.notifyQuestion(existing)
      return existing
    }
    const question: LabAssistantQuestion = {
      id: randomUUID(),
      status: 'open',
      createdAt: this.clock(),
      ...input
    }
    this.questions.unshift(question)
    this.notifyQuestion(question)
    return question
  }

  private notifyQuestion(question: LabAssistantQuestion): void {
    this.host.notify({
      type: 'task.needs_attention',
      title: 'Lab Assistant needs a decision',
      body: question.prompt,
      createdAt: question.createdAt
    })
  }

  private ownerThreads(pullRequest: LabAssistantPullRequest): SupervisedThread[] {
    const repositoryName = pullRequest.repository.split('/').pop()?.toLowerCase()
    return this.host.threads().filter((thread) => {
      if (thread.worktreeBranch !== pullRequest.headBranch) return false
      return !repositoryName || basename(thread.projectPath).toLowerCase() === repositoryName
    })
  }

  private conflictMessage(pullRequest: LabAssistantPullRequest): string {
    return [
      '[Lab Assistant]',
      `PR #${pullRequest.number} (${pullRequest.title}) is reported as conflicted against ${pullRequest.baseBranch}.`,
      'Rebase or merge the base branch, resolve the conflicts, rerun the relevant tests, and update the PR.'
    ].join(' ')
  }

  private conflictOwnerOptions(pullRequest: LabAssistantPullRequest, owners: SupervisedThread[]): Array<{ id: string; label: string }> {
    if (owners.length) return owners.map((owner) => ({ id: owner.threadId, label: owner.title }))
    const repositoryName = pullRequest.repository.split('/').pop()?.toLowerCase()
    const projectThreads = this.host.threads().filter((thread) =>
      !repositoryName || basename(thread.projectPath).toLowerCase() === repositoryName
    )
    if (projectThreads.length) return projectThreads.map((thread) => ({ id: thread.threadId, label: thread.title }))
    return [{ id: 'manual', label: "I'll handle it" }]
  }

  private async routeConflict(pullRequest: LabAssistantPullRequest): Promise<void> {
    if (pullRequest.state !== 'open' || pullRequest.mergeability !== 'conflicted' || pullRequest.conflictRoutedTo) return
    const owners = this.ownerThreads(pullRequest)
    if (owners.length === 1) {
      const owner = owners[0]
      try {
        await this.host.messageAgent(owner.threadId, this.conflictMessage(pullRequest))
        pullRequest.conflictRoutedTo = owner.threadId
        this.addActivity({
          kind: 'agent-message',
          title: `Routed PR #${pullRequest.number} conflict`,
          detail: `Asked ${owner.title} to resolve conflicts against ${pullRequest.baseBranch}.`,
          repository: pullRequest.repository,
          pullRequestId: pullRequest.id,
          threadId: owner.threadId
        })
        return
      } catch {
        /* A durable question below is safer than dropping a failed delivery. */
      }
    }
    const reason = owners.length === 0
      ? 'no owning agent could be matched'
      : owners.length === 1 ? 'the message to its owner could not be delivered' : 'more than one owning agent matched'
    this.addQuestion({
      key: `conflict-owner:${pullRequest.id}`,
      repository: pullRequest.repository,
      prompt: `PR #${pullRequest.number} has merge conflicts, but ${reason}. Who should handle it?`,
      options: this.conflictOwnerOptions(pullRequest, owners)
    })
  }

  private considerMergeOrder(pullRequest: LabAssistantPullRequest): void {
    if (pullRequest.state !== 'open' || pullRequest.mergeability !== 'clean') return
    const groupKey = `${pullRequest.repository}:${pullRequest.baseBranch}`
    if (this.mergeOrders[groupKey]) return
    const ready = this.pullRequests
      .filter((candidate) => candidate.repository === pullRequest.repository
        && candidate.baseBranch === pullRequest.baseBranch
        && candidate.state === 'open'
        && candidate.mergeability === 'clean')
      .sort((a, b) => a.number - b.number)
    if (ready.length < 2) return
    const signature = ready.map((candidate) => candidate.id).join(',')
    this.addQuestion({
      key: `merge-order:${groupKey}:${signature}`,
      repository: pullRequest.repository,
      prompt: `${ready.length} pull requests are ready for ${pullRequest.baseBranch}, but no merge order is recorded. Which should merge first?`,
      options: ready.map((candidate) => ({ id: candidate.id, label: `#${candidate.number} · ${candidate.title}` }))
    })
  }

  private upsertPullRequest(incoming: LabAssistantPullRequest): LabAssistantPullRequest {
    const index = this.pullRequests.findIndex((item) => item.id === incoming.id)
    const previous = index >= 0 ? this.pullRequests[index] : undefined
    const sameConflictEpisode = previous?.mergeability === 'conflicted' && incoming.mergeability === 'conflicted'
    const updated = { ...incoming, conflictRoutedTo: sameConflictEpisode ? previous.conflictRoutedTo : undefined }
    if (index >= 0) this.pullRequests[index] = updated
    else this.pullRequests.push(updated)
    return updated
  }

  /** Observe an already-authenticated GitHub delivery from the automation hook.
   * Deterministic policy handles the safety boundary; a model can later propose
   * plans without being trusted to invent authorization or repository state. */
  observeGitHub(delivery: GitHubDelivery): Promise<LabAssistantSnapshot> {
    return this.mutate(() => this.observeGitHubNow(delivery))
  }

  private async observeGitHubNow(delivery: GitHubDelivery): Promise<LabAssistantSnapshot> {
    await this.load()
    const incoming = pullRequestFromDelivery(delivery, this.clock())
    if (!incoming) return this.currentSnapshot()
    const updated = this.upsertPullRequest(incoming)
    this.addActivity({
      kind: 'pull-request',
      title: `Observed PR #${updated.number}`,
      detail: `${delivery.action ?? 'updated'} · ${updated.mergeability} · ${updated.headBranch} → ${updated.baseBranch}`,
      repository: updated.repository,
      pullRequestId: updated.id
    })
    let observations = [updated]
    // GitHub webhook payloads frequently report mergeability as unknown. Use
    // the authenticated CLI view as the authoritative snapshot on every PR
    // event, rather than waiting for the merge event that exposes a conflict.
    if (this.host.refreshPullRequests) {
      try {
        const refreshed = await this.host.refreshPullRequests(updated.repository)
        // A successful refresh replaces the delivery as the decision input.
        // The webhook is still retained for merged/closed history and activity.
        observations = refreshed.map((pullRequest) => this.upsertPullRequest(pullRequest))
      } catch (error) {
        this.addActivity({
          kind: 'pull-request',
          title: 'Could not refresh pull requests',
          detail: error instanceof Error ? error.message : String(error),
          repository: updated.repository,
          pullRequestId: updated.id
        })
      }
    }
    for (const observation of observations) {
      await this.routeConflict(observation)
      this.considerMergeOrder(observation)
    }
    await this.save()
    const snapshot = this.currentSnapshot()
    this.host.emit(snapshot)
    return snapshot
  }

  answer(questionId: string, answerId: string): Promise<LabAssistantSnapshot> {
    return this.mutate(() => this.answerNow(questionId, answerId))
  }

  private async answerNow(questionId: string, answerId: string): Promise<LabAssistantSnapshot> {
    await this.load()
    const question = this.questions.find((item) => item.id === questionId)
    if (!question) throw new Error(`Lab Assistant question ${questionId} does not exist.`)
    if (question.status !== 'open') throw new Error('That Lab Assistant question was already answered.')
    const answer = question.options.find((option) => option.id === answerId)
    if (!answer) throw new Error('Choose one of the recorded Lab Assistant options.')
    if (question.key.startsWith('conflict-owner:') && answer.id !== 'manual') {
      const pullRequest = this.pullRequests.find((item) => item.id === question.key.slice('conflict-owner:'.length))
      if (!pullRequest) throw new Error('The pull request for that decision is no longer available.')
      await this.host.messageAgent(answer.id, this.conflictMessage(pullRequest))
      pullRequest.conflictRoutedTo = answer.id
      this.addActivity({
        kind: 'agent-message',
        title: `Routed PR #${pullRequest.number} conflict`,
        detail: `Asked ${answer.label} to resolve conflicts against ${pullRequest.baseBranch}.`,
        repository: pullRequest.repository,
        pullRequestId: pullRequest.id,
        threadId: answer.id
      })
    } else if (question.key.startsWith('conflict-owner:') && answer.id === 'manual') {
      const pullRequest = this.pullRequests.find((item) => item.id === question.key.slice('conflict-owner:'.length))
      if (pullRequest) pullRequest.conflictRoutedTo = 'manual'
    }
    question.status = 'answered'
    question.answerId = answer.id
    question.answeredAt = this.clock()
    if (question.key.startsWith('merge-order:')) {
      const selected = this.pullRequests.find((pullRequest) => pullRequest.id === answer.id)
      if (selected) {
        const groupKey = `${selected.repository}:${selected.baseBranch}`
        const rest = this.pullRequests
          .filter((pullRequest) => pullRequest.repository === selected.repository
            && pullRequest.baseBranch === selected.baseBranch
            && pullRequest.state === 'open'
            && pullRequest.id !== selected.id)
          .sort((a, b) => a.number - b.number)
          .map((pullRequest) => pullRequest.id)
        this.mergeOrders[groupKey] = [selected.id, ...rest]
      }
    }
    this.addActivity({
      kind: 'decision',
      title: 'Recorded your decision',
      detail: `${question.prompt} ${answer.label}`,
      repository: question.repository
    })
    await this.save()
    const snapshot = this.currentSnapshot()
    this.host.emit(snapshot)
    return snapshot
  }

  async handle(request: { type: string; questionId?: string; answerId?: string }): Promise<unknown> {
    if (request.type === 'assistant.snapshot') return this.snapshot()
    if (request.type === 'assistant.answer') return this.answer(String(request.questionId ?? ''), String(request.answerId ?? ''))
    throw new Error(`Unsupported Lab Assistant request: ${request.type}`)
  }
}
