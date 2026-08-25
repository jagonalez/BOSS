import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import type { GitHubDelivery } from '../shared/automation-trigger'
import type {
  LabAssistantActivity,
  LabAssistantAgentConfig,
  LabAssistantCiIncident,
  LabAssistantCiJob,
  LabAssistantMergeability,
  LabAssistantPullRequest,
  LabAssistantQuestion,
  LabAssistantSnapshot,
  LabAssistantTask,
  LabAssistantTaskInput,
  LabAssistantTaskPatch,
  LabAssistantTaskPlan,
  LabAssistantTaskStatus,
  LabAssistantWorkflowConfig,
  LabAssistantWorkflowRole,
  LabAssistantWorkflowRun
} from '../shared/lab-assistant'
// @ts-expect-error Node's type-stripping test runner needs the extension.
import { workflowRunFromDelivery, type GitHubWorkflowRunObservation } from './lab-assistant-github.ts'
import type { BackendRequest } from '../shared/backend'
// @ts-expect-error Node's type-stripping test runner needs the extension.
import { isBackendId } from '../shared/backend.ts'
import type { BossEvent } from '../shared/notification'
import type { SupervisedThread } from '../shared/supervision'

interface StoredLabAssistantState {
  version: 1
  tasks: LabAssistantTask[]
  taskPlans: Record<string, LabAssistantTaskPlan>
  pullRequests: LabAssistantPullRequest[]
  ciIncidents: LabAssistantCiIncident[]
  questions: LabAssistantQuestion[]
  activities: LabAssistantActivity[]
  mergeOrders: Record<string, string[]>
  workflowConfig?: LabAssistantWorkflowConfig
  workflowRuns?: LabAssistantWorkflowRun[]
}

export interface LabAssistantHost {
  threads(): SupervisedThread[]
  messageAgent(threadId: string, message: string): Promise<void>
  refreshPullRequests?(repository: string): Promise<LabAssistantPullRequest[]>
  inspectWorkflowRun?(repository: string, runId: number, attempt: number): Promise<LabAssistantCiJob[]>
  createWorkflowStage?(input: {
    role: LabAssistantWorkflowRole
    backendId: LabAssistantWorkflowConfig['planner']['backendId']
    title: string
    projectPath?: string
    sourceThreadId?: string
  }): Promise<string>
  runWorkflowStage?(
    threadId: string,
    role: LabAssistantWorkflowRole,
    agent: LabAssistantWorkflowConfig['planner'],
    instruction: string,
    sourceThreadId?: string
  ): Promise<void>
  workflowReviewVerdict?(threadId: string): Promise<{ verdict: 'pass' | 'changes-requested'; notes: string[] } | undefined>
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

function taskGroup(task: Pick<LabAssistantTask, 'projectPath'>): string {
  return task.projectPath || 'global'
}

function taskScopeLabel(task: Pick<LabAssistantTask, 'projectPath'>): string {
  return task.projectPath ? basename(task.projectPath) : 'Global'
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalizeWorkflowAgent(agent: LabAssistantAgentConfig, label: string): LabAssistantAgentConfig {
  if (!agent || !isBackendId(agent.backendId)) throw new Error(`Choose a valid ${label} backend.`)
  const model = agent.model
  if (model && (!text(model.modelID) || !text(model.providerID))) {
    throw new Error(`Choose a valid ${label} model.`)
  }
  return {
    backendId: agent.backendId,
    ...(model ? {
      model: {
        modelID: text(model.modelID),
        providerID: text(model.providerID),
        ...(text(model.variant) ? { variant: text(model.variant) } : {})
      }
    } : {}),
    ...(text(agent.instruction) ? { instruction: text(agent.instruction).slice(0, 2_000) } : {})
  }
}

function normalizeWorkflowConfig(config: LabAssistantWorkflowConfig): LabAssistantWorkflowConfig {
  if (!config || !Array.isArray(config.reviewers) || config.reviewers.length === 0) {
    throw new Error('Add at least one reviewer to the managed workflow.')
  }
  const maxReviewCycles = Number.isFinite(config.maxReviewCycles)
    ? Math.max(1, Math.min(5, Math.floor(config.maxReviewCycles)))
    : 1
  return {
    planner: normalizeWorkflowAgent(config.planner, 'planner'),
    implementer: normalizeWorkflowAgent(config.implementer, 'implementer'),
    reviewers: config.reviewers.slice(0, 5).map((reviewer, index) => normalizeWorkflowAgent(reviewer, `reviewer ${index + 1}`)),
    maxReviewCycles
  }
}

export class LabAssistantManager {
  private readonly stateFile: string
  private readonly host: LabAssistantHost
  private readonly clock: () => number
  private loaded = false
  private tasks: LabAssistantTask[] = []
  private taskPlans: Record<string, LabAssistantTaskPlan> = {}
  private pullRequests: LabAssistantPullRequest[] = []
  private ciIncidents: LabAssistantCiIncident[] = []
  private questions: LabAssistantQuestion[] = []
  private activities: LabAssistantActivity[] = []
  private mergeOrders: Record<string, string[]> = {}
  private workflowConfig?: LabAssistantWorkflowConfig
  private workflowRuns: LabAssistantWorkflowRun[] = []
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
      if (Array.isArray(parsed.tasks)) this.tasks = parsed.tasks
      if (parsed.taskPlans && typeof parsed.taskPlans === 'object') this.taskPlans = parsed.taskPlans
      if (Array.isArray(parsed.pullRequests)) this.pullRequests = parsed.pullRequests
      if (Array.isArray(parsed.ciIncidents)) this.ciIncidents = parsed.ciIncidents
      if (Array.isArray(parsed.questions)) this.questions = parsed.questions
      if (Array.isArray(parsed.activities)) this.activities = parsed.activities.slice(0, ACTIVITY_CAP)
      if (parsed.mergeOrders && typeof parsed.mergeOrders === 'object') this.mergeOrders = parsed.mergeOrders
      if (parsed.workflowConfig) this.workflowConfig = parsed.workflowConfig
      if (Array.isArray(parsed.workflowRuns)) this.workflowRuns = parsed.workflowRuns
    } catch {
      /* First launch or a corrupt optional state file starts empty. */
    }
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.stateFile), { recursive: true })
    const state: StoredLabAssistantState = {
      version: 1,
      tasks: this.tasks,
      taskPlans: this.taskPlans,
      pullRequests: this.pullRequests,
      ciIncidents: this.ciIncidents,
      questions: this.questions,
      activities: this.activities,
      mergeOrders: this.mergeOrders,
      workflowConfig: this.workflowConfig,
      workflowRuns: this.workflowRuns
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
      tasks: clone(this.tasks),
      taskPlans: clone(this.taskPlans),
      pullRequests: clone(this.pullRequests),
      ciIncidents: clone(this.ciIncidents),
      questions: clone(this.questions),
      activities: clone(this.activities),
      mergeOrders: clone(this.mergeOrders),
      ...(this.workflowConfig ? { workflowConfig: clone(this.workflowConfig) } : {}),
      workflowRuns: clone(this.workflowRuns)
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
      delete existing.dismissedAt
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

  private task(id: string): LabAssistantTask {
    const task = this.tasks.find((item) => item.id === id)
    if (!task) throw new Error(`Lab Assistant task ${id || '(missing)'} does not exist.`)
    return task
  }

  private incompleteDependencies(task: LabAssistantTask): LabAssistantTask[] {
    return task.dependsOn
      .map((id) => this.tasks.find((candidate) => candidate.id === id))
      .filter((candidate): candidate is LabAssistantTask => Boolean(candidate && candidate.status !== 'done'))
  }

  private incompletePlanPredecessors(task: LabAssistantTask): LabAssistantTask[] {
    const plan = this.taskPlans[taskGroup(task)]
    if (!plan || plan.mode !== 'ordered') return []
    const index = plan.taskIds.indexOf(task.id)
    if (index <= 0) return []
    return plan.taskIds.slice(0, index)
      .map((id) => this.tasks.find((candidate) => candidate.id === id))
      .filter((candidate): candidate is LabAssistantTask => Boolean(candidate && candidate.status !== 'done'))
  }

  private taskBlockers(task: LabAssistantTask): LabAssistantTask[] {
    const blockers = [...this.incompleteDependencies(task), ...this.incompletePlanPredecessors(task)]
    return [...new Map(blockers.map((blocker) => [blocker.id, blocker])).values()]
  }

  private validateDependencies(candidate: LabAssistantTask): void {
    if (new Set(candidate.dependsOn).size !== candidate.dependsOn.length) {
      throw new Error('A task dependency can only be listed once.')
    }
    if (candidate.dependsOn.includes(candidate.id)) throw new Error('A task cannot depend on itself.')
    const missing = candidate.dependsOn.find((id) => !this.tasks.some((task) => task.id === id))
    if (missing) throw new Error(`Task dependency ${missing} does not exist.`)

    const dependenciesFor = (id: string): string[] => id === candidate.id
      ? candidate.dependsOn
      : this.tasks.find((task) => task.id === id)?.dependsOn ?? []
    const reachesCandidate = (id: string, visited: Set<string>): boolean => {
      if (id === candidate.id) return true
      if (visited.has(id)) return false
      visited.add(id)
      return dependenciesFor(id).some((dependency) => reachesCandidate(dependency, visited))
    }
    if (candidate.dependsOn.some((id) => reachesCandidate(id, new Set()))) {
      throw new Error('Task dependencies cannot form a cycle.')
    }
  }

  private reconcileBlockedTasks(): void {
    for (const task of this.tasks) {
      const blocked = this.taskBlockers(task).length > 0
      if (task.status === 'ready' && blocked) task.status = 'blocked'
      else if (task.status === 'blocked' && !blocked) task.status = 'ready'
    }
  }

  private considerTaskOrders(): void {
    const readyIds = new Set(this.tasks
      .filter((task) => task.status === 'ready' && !task.assignedThreadId)
      .map((task) => task.id))
    for (const question of this.questions) {
      if (question.status !== 'open' || !question.key.startsWith('task-order:')) continue
      const questionTaskIds = question.options.filter((option) => option.id !== 'parallel').map((option) => option.id)
      if (questionTaskIds.some((id) => !readyIds.has(id))) {
        question.status = 'dismissed'
        question.dismissedAt = this.clock()
      }
    }
    const groups = new Set(this.tasks.map((task) => taskGroup(task)))
    for (const group of groups) {
      const ready = this.tasks
        .filter((task) => taskGroup(task) === group && task.status === 'ready' && !task.assignedThreadId)
        // Array.sort is stable: equal timestamps keep the order the user added
        // the tasks instead of being shuffled by their random UUIDs.
        .sort((a, b) => a.createdAt - b.createdAt)
      if (ready.length < 2) continue
      const plan = this.taskPlans[group]
      if (plan && ready.every((task) => plan.taskIds.includes(task.id))) continue
      const signature = ready.map((task) => task.id).sort().join(',')
      this.addQuestion({
        key: `task-order:${group}:${signature}`,
        repository: group === 'global' ? 'Global' : group,
        prompt: `${ready.length} ${group === 'global' ? 'global' : taskScopeLabel(ready[0])} tasks are ready. What should Lab Assistant do first?`,
        options: [
          ...ready.map((task) => ({ id: task.id, label: task.title })),
          { id: 'parallel', label: 'Run in parallel' }
        ]
      })
    }
  }

  private async finishMutation(): Promise<LabAssistantSnapshot> {
    await this.save()
    const snapshot = this.currentSnapshot()
    this.host.emit(snapshot)
    return snapshot
  }

  createTask(input: LabAssistantTaskInput): Promise<LabAssistantSnapshot> {
    return this.mutate(() => this.createTaskNow(input))
  }

  private async createTaskNow(input: LabAssistantTaskInput): Promise<LabAssistantSnapshot> {
    await this.load()
    const title = text(input.title)
    if (!title) throw new Error('A Lab Assistant task needs a title.')
    const now = this.clock()
    const task: LabAssistantTask = {
      id: randomUUID(),
      title,
      ...(text(input.details) ? { details: text(input.details) } : {}),
      ...(text(input.projectPath) ? { projectPath: text(input.projectPath) } : {}),
      status: 'ready',
      dependsOn: [...new Set((input.dependsOn ?? []).map(text).filter(Boolean))],
      createdAt: now,
      updatedAt: now
    }
    this.validateDependencies(task)
    if (this.incompleteDependencies(task).length) task.status = 'blocked'
    this.tasks.push(task)
    this.considerTaskOrders()
    this.addActivity({
      kind: 'task',
      title: `Added ${task.title}`,
      detail: `${taskScopeLabel(task)} · ${task.status}`,
      taskId: task.id
    })
    return this.finishMutation()
  }

  updateTask(taskId: string, patch: LabAssistantTaskPatch): Promise<LabAssistantSnapshot> {
    return this.mutate(() => this.updateTaskNow(taskId, patch))
  }

  private async updateTaskNow(taskId: string, patch: LabAssistantTaskPatch): Promise<LabAssistantSnapshot> {
    await this.load()
    const task = this.task(taskId)
    const candidate: LabAssistantTask = {
      ...task,
      ...('title' in patch ? { title: text(patch.title) } : {}),
      ...('details' in patch ? { details: text(patch.details) || undefined } : {}),
      ...('projectPath' in patch ? { projectPath: text(patch.projectPath) || undefined } : {}),
      ...('dependsOn' in patch ? { dependsOn: [...new Set((patch.dependsOn ?? []).map(text).filter(Boolean))] } : {}),
      ...('status' in patch ? { status: patch.status as LabAssistantTaskStatus } : {}),
      updatedAt: this.clock()
    }
    if (!candidate.title) throw new Error('A Lab Assistant task needs a title.')
    if (!['inbox', 'ready', 'blocked', 'running', 'review', 'done'].includes(candidate.status)) {
      throw new Error(`Invalid Lab Assistant task status: ${String(candidate.status)}.`)
    }
    this.validateDependencies(candidate)
    const incomplete = this.taskBlockers(candidate)
    if (incomplete.length && ['ready', 'running', 'review'].includes(candidate.status)) {
      throw new Error(`Complete ${incomplete.map((item) => item.title).join(', ')} before advancing this task.`)
    }
    if (candidate.status === 'done') candidate.completedAt = this.clock()
    else delete candidate.completedAt
    Object.assign(task, candidate)
    this.reconcileBlockedTasks()
    this.considerTaskOrders()
    this.addActivity({
      kind: 'task',
      title: `${task.title} is ${task.status}`,
      detail: `${taskScopeLabel(task)} task updated.`,
      taskId: task.id
    })
    return this.finishMutation()
  }

  assignTask(taskId: string, threadId: string): Promise<LabAssistantSnapshot> {
    return this.mutate(() => this.assignTaskNow(taskId, threadId))
  }

  private async assignTaskNow(taskId: string, threadId: string): Promise<LabAssistantSnapshot> {
    await this.load()
    const task = this.task(taskId)
    const thread = this.host.threads().find((candidate) => candidate.threadId === threadId)
    if (!thread) throw new Error(`Agent thread ${threadId || '(missing)'} does not exist.`)
    if (task.projectPath && task.projectPath !== thread.projectPath) {
      throw new Error('Choose an agent working in the same project as this task.')
    }
    if (task.assignedThreadId === threadId && task.status === 'running') return this.currentSnapshot()
    if (task.status !== 'ready') throw new Error('Only a ready task can be assigned to an agent.')
    const pendingOrder = this.questions.find((question) => question.status === 'open'
      && question.key.startsWith('task-order:')
      && question.options.some((option) => option.id === task.id))
    if (pendingOrder) throw new Error('Choose the task order before assigning this work.')
    const incomplete = this.taskBlockers(task)
    if (incomplete.length) throw new Error(`Complete ${incomplete.map((item) => item.title).join(', ')} before assigning this task.`)
    const details = task.details ? ` Context: ${task.details}` : ''
    await this.host.messageAgent(threadId, `[Lab Assistant] Take ownership of task: ${task.title}.${details} Report progress and any blocker back to the user.`)
    task.assignedThreadId = threadId
    task.status = 'running'
    task.updatedAt = this.clock()
    this.addActivity({
      kind: 'agent-message',
      title: `Assigned ${task.title}`,
      detail: `Asked ${thread.title} to take ownership.`,
      taskId: task.id,
      threadId
    })
    return this.finishMutation()
  }

  configureWorkflow(config: LabAssistantWorkflowConfig): Promise<LabAssistantSnapshot> {
    return this.mutate(async () => {
      await this.load()
      this.workflowConfig = normalizeWorkflowConfig(config)
      this.addActivity({
        kind: 'workflow',
        title: 'Saved managed workflow',
        detail: `Planner, implementer, ${this.workflowConfig.reviewers.length} reviewer${this.workflowConfig.reviewers.length === 1 ? '' : 's'} · ${this.workflowConfig.maxReviewCycles} review cycle${this.workflowConfig.maxReviewCycles === 1 ? '' : 's'}.`
      })
      return this.finishMutation()
    })
  }

  startWorkflow(taskId: string): Promise<LabAssistantSnapshot> {
    return this.mutate(() => this.startWorkflowNow(taskId))
  }

  private async startWorkflowNow(taskId: string): Promise<LabAssistantSnapshot> {
    await this.load()
    if (!this.host.createWorkflowStage || !this.host.runWorkflowStage || !this.host.workflowReviewVerdict) {
      throw new Error('Managed workflows are unavailable in this build.')
    }
    if (!this.workflowConfig) throw new Error('Configure the managed workflow before starting it.')
    const task = this.task(taskId)
    if (!task.projectPath) throw new Error('Managed workflows need a project-specific task.')
    if (task.status !== 'ready') throw new Error('Only a ready task can start a managed workflow.')
    if (this.workflowRuns.some((run) => run.taskId === task.id && run.status === 'running')) {
      throw new Error('That task already has a running managed workflow.')
    }
    const pendingOrder = this.questions.find((question) => question.status === 'open'
      && question.key.startsWith('task-order:')
      && question.options.some((option) => option.id === task.id))
    if (pendingOrder) throw new Error('Choose the task order before starting this work.')
    const incomplete = this.taskBlockers(task)
    if (incomplete.length) throw new Error(`Complete ${incomplete.map((item) => item.title).join(', ')} before starting this task.`)

    const now = this.clock()
    const run: LabAssistantWorkflowRun = {
      id: randomUUID(),
      taskId: task.id,
      title: task.title,
      projectPath: task.projectPath,
      status: 'running',
      stage: 'planning',
      config: clone(this.workflowConfig),
      reviewCycle: 1,
      reviews: [],
      createdAt: now,
      updatedAt: now
    }
    this.workflowRuns.unshift(run)
    task.status = 'running'
    task.updatedAt = now
    this.addActivity({
      kind: 'workflow',
      title: `Planning ${task.title}`,
      detail: 'Managed workflow started.',
      taskId: task.id,
      workflowRunId: run.id
    })

    try {
      const threadId = await this.host.createWorkflowStage({
        role: 'planner',
        backendId: run.config.planner.backendId,
        title: `Plan · ${task.title}`,
        projectPath: task.projectPath
      })
      run.plannerThreadId = threadId
      task.assignedThreadId = threadId
      await this.workflowCheckpoint()
      await this.host.runWorkflowStage(threadId, 'planner', run.config.planner, this.plannerPrompt(task))
    } catch (error) {
      this.workflowNeedsAttention(run, task, `Planner could not start: ${errorMessage(error)}`)
    }
    return this.finishMutation()
  }

  private plannerPrompt(task: LabAssistantTask): string {
    return [
      '[Lab Assistant managed workflow — planner]',
      `Plan this task: ${task.title}.`,
      task.details ? `User context: ${task.details}` : '',
      'Inspect the project and produce a concrete implementation plan. Do not edit files.',
      'Call out risks, required tests, and anything that needs a user decision.',
      this.workflowConfig?.planner.instruction ?? ''
    ].filter(Boolean).join('\n\n')
  }

  private implementationPrompt(run: LabAssistantWorkflowRun, task: LabAssistantTask): string {
    return [
      '[Lab Assistant managed workflow — implementer]',
      `Implement the planned task: ${task.title}.`,
      task.details ? `User context: ${task.details}` : '',
      'Work in the isolated Git worktree created for this thread. Follow the planner handoff, update tests with behavior, and verify the change as far as the environment permits.',
      run.config.implementer.instruction ?? ''
    ].filter(Boolean).join('\n\n')
  }

  private reviewerPrompt(run: LabAssistantWorkflowRun, task: LabAssistantTask, reviewerIndex: number): string {
    const reviewer = run.config.reviewers[reviewerIndex]
    return [
      '[Lab Assistant managed workflow — reviewer]',
      `Review the implementation of: ${task.title}.`,
      'Inspect the implementation checkout, tests, and the implementer handoff. Do not edit files.',
      'End your final response with exactly PASS or CHANGES_REQUESTED. For changes, put actionable bullet points after CHANGES_REQUESTED.',
      reviewer.instruction ?? ''
    ].filter(Boolean).join('\n\n')
  }

  private async workflowCheckpoint(): Promise<void> {
    await this.save()
    this.host.emit(this.currentSnapshot())
  }

  private workflowNeedsAttention(run: LabAssistantWorkflowRun, task: LabAssistantTask, detail: string): void {
    const now = this.clock()
    run.status = 'needs-attention'
    run.updatedAt = now
    task.status = run.stage === 'reviewing' ? 'review' : 'running'
    task.updatedAt = now
    this.addQuestion({
      key: `workflow:${run.id}:${run.reviewCycle}:${run.stage}`,
      repository: task.projectPath ?? 'Global',
      prompt: `${task.title}: ${detail}`,
      options: [
        { id: 'manual', label: "I'll take over" },
        { id: 'stop', label: 'Stop and return to ready' }
      ]
    })
    this.addActivity({
      kind: 'workflow',
      title: `${task.title} needs attention`,
      detail,
      taskId: task.id,
      workflowRunId: run.id
    })
  }

  private async startImplementer(run: LabAssistantWorkflowRun, task: LabAssistantTask): Promise<void> {
    if (!run.plannerThreadId) throw new Error('The planner thread is missing.')
    if (!this.host.createWorkflowStage || !this.host.runWorkflowStage) throw new Error('Managed workflows are unavailable in this build.')
    const threadId = await this.host.createWorkflowStage({
      role: 'implementer',
      backendId: run.config.implementer.backendId,
      title: `Implement · ${task.title}`,
      sourceThreadId: run.plannerThreadId
    })
    run.implementerThreadId = threadId
    run.stage = 'implementing'
    run.updatedAt = this.clock()
    task.status = 'running'
    task.assignedThreadId = threadId
    task.updatedAt = run.updatedAt
    this.addActivity({
      kind: 'workflow',
      title: `Implementing ${task.title}`,
      detail: 'Planner handoff delivered to an isolated worktree.',
      taskId: task.id,
      workflowRunId: run.id,
      threadId
    })
    await this.workflowCheckpoint()
    await this.host.runWorkflowStage(threadId, 'implementer', run.config.implementer, this.implementationPrompt(run, task), run.plannerThreadId)
  }

  private async startReviewer(run: LabAssistantWorkflowRun, task: LabAssistantTask, reviewerIndex: number): Promise<void> {
    if (!run.implementerThreadId) throw new Error('The implementer thread is missing.')
    if (!this.host.createWorkflowStage || !this.host.runWorkflowStage) throw new Error('Managed workflows are unavailable in this build.')
    const reviewer = run.config.reviewers[reviewerIndex]
    const threadId = await this.host.createWorkflowStage({
      role: 'reviewer',
      backendId: reviewer.backendId,
      title: `Review ${reviewerIndex + 1} · ${task.title}`,
      sourceThreadId: run.implementerThreadId
    })
    const now = this.clock()
    run.stage = 'reviewing'
    run.updatedAt = now
    task.status = 'review'
    task.updatedAt = now
    run.reviews.push({
      cycle: run.reviewCycle,
      index: reviewerIndex,
      threadId,
      backendId: reviewer.backendId,
      status: 'running',
      startedAt: now
    })
    this.addActivity({
      kind: 'workflow',
      title: `Reviewing ${task.title}`,
      detail: `Review ${reviewerIndex + 1} of ${run.config.reviewers.length}, cycle ${run.reviewCycle}.`,
      taskId: task.id,
      workflowRunId: run.id,
      threadId
    })
    await this.workflowCheckpoint()
    await this.host.runWorkflowStage(threadId, 'reviewer', reviewer, this.reviewerPrompt(run, task, reviewerIndex), run.implementerThreadId)
  }

  private async returnToImplementer(run: LabAssistantWorkflowRun, task: LabAssistantTask, reviewThreadId: string, notes: string[]): Promise<void> {
    if (!run.implementerThreadId) throw new Error('The implementer thread is missing.')
    if (!this.host.runWorkflowStage) throw new Error('Managed workflows are unavailable in this build.')
    run.reviewCycle += 1
    run.stage = 'implementing'
    run.updatedAt = this.clock()
    task.status = 'running'
    task.updatedAt = run.updatedAt
    const instruction = [
      '[Lab Assistant managed workflow — review feedback]',
      `Review requested changes for ${task.title}. Address every point, update tests, and rerun relevant checks.`,
      notes.length ? notes.map((note) => `- ${note}`).join('\n') : '- Re-read the reviewer transcript and address the requested changes.',
      run.config.implementer.instruction ?? ''
    ].filter(Boolean).join('\n\n')
    this.addActivity({
      kind: 'workflow',
      title: `Revising ${task.title}`,
      detail: `Review feedback returned to the implementer for cycle ${run.reviewCycle}.`,
      taskId: task.id,
      workflowRunId: run.id,
      threadId: run.implementerThreadId
    })
    await this.workflowCheckpoint()
    await this.host.runWorkflowStage(run.implementerThreadId, 'implementer', run.config.implementer, instruction, reviewThreadId)
  }

  private completeWorkflow(run: LabAssistantWorkflowRun, task: LabAssistantTask): void {
    const now = this.clock()
    run.status = 'completed'
    run.updatedAt = now
    run.completedAt = now
    task.status = 'done'
    task.updatedAt = now
    task.completedAt = now
    this.reconcileBlockedTasks()
    this.considerTaskOrders()
    this.addActivity({
      kind: 'workflow',
      title: `Completed ${task.title}`,
      detail: `${run.config.reviewers.length} reviewer${run.config.reviewers.length === 1 ? '' : 's'} passed in cycle ${run.reviewCycle}.`,
      taskId: task.id,
      workflowRunId: run.id
    })
    this.host.notify({
      type: 'task.completed',
      title: `Lab Assistant completed ${task.title}`,
      body: 'Implementation and review are complete.',
      threadId: run.implementerThreadId,
      projectPath: task.projectPath,
      createdAt: now
    })
  }

  observeBackendEvent(event: Record<string, unknown>): Promise<void> {
    if (event.type !== 'thread.result') return Promise.resolve()
    return this.mutate(async () => {
      await this.load()
      const properties = record(event.properties)
      const threadId = text(properties.threadId)
      const result = record(properties.result)
      const run = this.workflowRuns.find((candidate) => candidate.status === 'running'
        && (candidate.plannerThreadId === threadId
          || candidate.implementerThreadId === threadId
          || candidate.reviews.some((review) => review.threadId === threadId && review.status === 'running')))
      if (!run) return
      const task = this.tasks.find((candidate) => candidate.id === run.taskId)
      if (!task) return
      const status = text(result.status)

      try {
        if (threadId === run.plannerThreadId) {
          if (status !== 'completed') this.workflowNeedsAttention(run, task, `Planner ended with ${status || 'an unknown error'}.`)
          else await this.startImplementer(run, task)
        } else if (threadId === run.implementerThreadId) {
          if (status !== 'completed') this.workflowNeedsAttention(run, task, `Implementer ended with ${status || 'an unknown error'}.`)
          else await this.startReviewer(run, task, 0)
        } else {
          const review = run.reviews.find((candidate) => candidate.threadId === threadId && candidate.status === 'running')
          if (!review) return
          review.finishedAt = this.clock()
          if (status !== 'completed') {
            review.status = 'failed'
            this.workflowNeedsAttention(run, task, `Reviewer ${review.index + 1} ended with ${status || 'an unknown error'}.`)
          } else {
            const verdict = await this.host.workflowReviewVerdict?.(threadId)
            if (!verdict) {
              review.status = 'no-verdict'
              this.workflowNeedsAttention(run, task, `Reviewer ${review.index + 1} finished without PASS or CHANGES_REQUESTED.`)
            } else if (verdict.verdict === 'changes-requested') {
              review.status = 'changes-requested'
              review.notes = verdict.notes.join('\n') || undefined
              if (run.reviewCycle >= run.config.maxReviewCycles) {
                this.workflowNeedsAttention(run, task, `Review still requests changes after ${run.reviewCycle} cycle${run.reviewCycle === 1 ? '' : 's'}.`)
              } else {
                await this.returnToImplementer(run, task, threadId, verdict.notes)
              }
            } else {
              review.status = 'passed'
              review.notes = verdict.notes.join('\n') || undefined
              const nextReviewer = review.index + 1
              if (nextReviewer < run.config.reviewers.length) await this.startReviewer(run, task, nextReviewer)
              else this.completeWorkflow(run, task)
            }
          }
        }
      } catch (error) {
        this.workflowNeedsAttention(run, task, `Could not advance the workflow: ${errorMessage(error)}`)
      }
      await this.finishMutation()
    })
  }

  private ownerThreadsForBranch(repository: string, headBranch: string): SupervisedThread[] {
    const repositoryName = repository.split('/').pop()?.toLowerCase()
    return this.host.threads().filter((thread) => {
      if (thread.worktreeBranch !== headBranch) return false
      return !repositoryName || basename(thread.projectPath).toLowerCase() === repositoryName
    })
  }

  private ownerThreads(pullRequest: LabAssistantPullRequest): SupervisedThread[] {
    return this.ownerThreadsForBranch(pullRequest.repository, pullRequest.headBranch)
  }

  private projectThreads(repository: string): SupervisedThread[] {
    const repositoryName = repository.split('/').pop()?.toLowerCase()
    return this.host.threads().filter((thread) =>
      !repositoryName || basename(thread.projectPath).toLowerCase() === repositoryName
    )
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
    const projectThreads = this.projectThreads(pullRequest.repository)
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

  private ciOwnerOptions(incident: LabAssistantCiIncident, owners: SupervisedThread[]): Array<{ id: string; label: string }> {
    if (owners.length) return owners.map((owner) => ({ id: owner.threadId, label: owner.title }))
    const projectThreads = this.projectThreads(incident.repository)
    if (projectThreads.length) return projectThreads.map((thread) => ({ id: thread.threadId, label: thread.title }))
    return [{ id: 'manual', label: "I'll investigate it" }]
  }

  private ciMessage(incident: LabAssistantCiIncident): string {
    const pullRequest = incident.pullRequestId
      ? this.pullRequests.find((candidate) => candidate.id === incident.pullRequestId)
      : undefined
    const target = pullRequest ? `PR #${pullRequest.number} (${pullRequest.title})` : `branch ${incident.headBranch}`
    const failures = incident.jobs.length
      ? incident.jobs.map((job) => `${job.name}${job.failedSteps.length ? ` — ${job.failedSteps.join(', ')}` : ''}`).join('; ')
      : 'GitHub did not report a failed job or step; inspect the run-level error'
    return [
      '[Lab Assistant]',
      `${incident.workflow} failed for ${target} (run #${incident.runNumber}, attempt ${incident.runAttempt}).`,
      `Failures: ${failures}.`,
      `Investigate the root cause, fix it, run the relevant tests, and update the pull request. ${incident.url}`
    ].join(' ')
  }

  private associateCiTask(incident: LabAssistantCiIncident, threadId: string): void {
    const task = this.tasks
      .filter((candidate) => candidate.assignedThreadId === threadId && candidate.status !== 'done')
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]
    if (task) incident.taskId = task.id
  }

  private async routeCiFailure(incident: LabAssistantCiIncident): Promise<void> {
    if (incident.status !== 'failing' || incident.routedDeliveryKey === incident.lastDeliveryKey) return
    const owners = this.ownerThreadsForBranch(incident.repository, incident.headBranch)
    if (owners.length === 1) {
      const owner = owners[0]
      try {
        await this.host.messageAgent(owner.threadId, this.ciMessage(incident))
        incident.routedTo = owner.threadId
        incident.routedDeliveryKey = incident.lastDeliveryKey
        this.associateCiTask(incident, owner.threadId)
        this.addActivity({
          kind: 'agent-message',
          title: `Routed ${incident.workflow} failure`,
          detail: `Asked ${owner.title} to investigate run #${incident.runNumber}, attempt ${incident.runAttempt}.`,
          repository: incident.repository,
          taskId: incident.taskId,
          pullRequestId: incident.pullRequestId,
          ciIncidentId: incident.id,
          threadId: owner.threadId
        })
        this.host.notify({
          type: 'task.failed',
          title: `${incident.workflow} failed`,
          body: `Lab Assistant asked ${owner.title} to investigate ${incident.headBranch}.`,
          threadId: owner.threadId,
          projectPath: owner.projectPath,
          createdAt: this.clock()
        })
        return
      } catch {
        /* Preserve the incident and ask the user who should receive it. */
      }
    }
    const reason = owners.length === 0
      ? 'no owning agent could be matched'
      : owners.length === 1 ? 'the message to its owner could not be delivered' : 'more than one owning agent matched'
    this.addQuestion({
      key: `ci-owner:${incident.id}:${incident.lastDeliveryKey}`,
      repository: incident.repository,
      prompt: `${incident.workflow} failed on ${incident.headBranch}, but ${reason}. Who should investigate it?`,
      options: this.ciOwnerOptions(incident, owners)
    })
  }

  private dismissCiQuestions(incidentId: string): void {
    for (const question of this.questions) {
      if (question.status === 'open' && question.key.startsWith(`ci-owner:${incidentId}:`)) {
        question.status = 'dismissed'
        question.dismissedAt = this.clock()
      }
    }
  }

  private async observeWorkflowRun(observation: GitHubWorkflowRunObservation): Promise<LabAssistantSnapshot> {
    const previousIndex = this.ciIncidents.findIndex((incident) => incident.id === observation.id)
    const previous = previousIndex >= 0 ? this.ciIncidents[previousIndex] : undefined
    if (previous?.lastDeliveryKey === observation.deliveryKey) return this.currentSnapshot()
    // Completed webhook deliveries are not guaranteed to arrive in order. An
    // older success must never resolve a newer failure episode.
    if (previous && (
      observation.runNumber < previous.runNumber
      || (observation.runNumber === previous.runNumber && observation.runAttempt < previous.runAttempt)
    )) return this.currentSnapshot()

    // A new attempt supersedes any unanswered routing decision for the prior
    // attempt. If the new attempt also needs a decision, routeCiFailure adds a
    // single fresh question with current evidence.
    this.dismissCiQuestions(observation.id)

    if (observation.conclusion === 'success') {
      if (!previous || previous.status !== 'failing') return this.currentSnapshot()
      const resolved: LabAssistantCiIncident = {
        ...previous,
        runId: observation.runId,
        runNumber: observation.runNumber,
        runAttempt: observation.runAttempt,
        url: observation.url,
        headSha: observation.headSha,
        conclusion: 'success',
        status: 'resolved',
        updatedAt: observation.observedAt,
        resolvedAt: observation.observedAt,
        lastDeliveryKey: observation.deliveryKey
      }
      this.ciIncidents[previousIndex] = resolved
      this.addActivity({
        kind: 'ci',
        title: `${resolved.workflow} recovered`,
        detail: `${resolved.headBranch} passed on run #${resolved.runNumber}, attempt ${resolved.runAttempt}.`,
        repository: resolved.repository,
        taskId: resolved.taskId,
        pullRequestId: resolved.pullRequestId,
        ciIncidentId: resolved.id,
        threadId: resolved.routedTo && resolved.routedTo !== 'manual' ? resolved.routedTo : undefined
      })
      return this.finishMutation()
    }

    let jobs: LabAssistantCiJob[] = []
    if (this.host.inspectWorkflowRun) {
      try {
        jobs = await this.host.inspectWorkflowRun(observation.repository, observation.runId, observation.runAttempt)
      } catch (error) {
        this.addActivity({
          kind: 'ci',
          title: `Could not inspect ${observation.workflow}`,
          detail: error instanceof Error ? error.message : String(error),
          repository: observation.repository,
          pullRequestId: observation.pullRequestId,
          ciIncidentId: observation.id
        })
      }
    }
    const sameEpisode = previous?.status === 'failing'
    const incident: LabAssistantCiIncident = {
      id: observation.id,
      repository: observation.repository,
      workflowId: observation.workflowId,
      workflow: observation.workflow,
      runId: observation.runId,
      runNumber: observation.runNumber,
      runAttempt: observation.runAttempt,
      url: observation.url,
      headBranch: observation.headBranch,
      headSha: observation.headSha,
      ...(observation.pullRequestId ? { pullRequestId: observation.pullRequestId } : {}),
      conclusion: observation.conclusion,
      status: 'failing',
      jobs,
      occurrenceCount: sameEpisode ? previous.occurrenceCount + 1 : 1,
      firstFailedAt: sameEpisode ? previous.firstFailedAt : observation.observedAt,
      updatedAt: observation.observedAt,
      ...(sameEpisode && previous.taskId ? { taskId: previous.taskId } : {}),
      ...(sameEpisode && previous.routedTo ? { routedTo: previous.routedTo } : {}),
      ...(sameEpisode && previous.routedDeliveryKey ? { routedDeliveryKey: previous.routedDeliveryKey } : {}),
      lastDeliveryKey: observation.deliveryKey
    }
    if (previousIndex >= 0) this.ciIncidents[previousIndex] = incident
    else this.ciIncidents.unshift(incident)
    this.addActivity({
      kind: 'ci',
      title: `${incident.workflow} failed`,
      detail: `${incident.headBranch} · run #${incident.runNumber}, attempt ${incident.runAttempt} · ${incident.jobs.length || 'no'} failed jobs`,
      repository: incident.repository,
      pullRequestId: incident.pullRequestId,
      ciIncidentId: incident.id
    })
    await this.routeCiFailure(incident)
    return this.finishMutation()
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
    const workflowRun = workflowRunFromDelivery(delivery, this.clock())
    if (workflowRun) return this.observeWorkflowRun(workflowRun)
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
    if (question.key.startsWith('ci-owner:')) {
      const incident = this.ciIncidents.find((candidate) => question.key.startsWith(`ci-owner:${candidate.id}:`))
      if (!incident) throw new Error('The CI failure for that decision is no longer available.')
      if (answer.id === 'manual') {
        incident.routedTo = 'manual'
        incident.routedDeliveryKey = incident.lastDeliveryKey
      } else {
        await this.host.messageAgent(answer.id, this.ciMessage(incident))
        incident.routedTo = answer.id
        incident.routedDeliveryKey = incident.lastDeliveryKey
        this.associateCiTask(incident, answer.id)
        this.addActivity({
          kind: 'agent-message',
          title: `Routed ${incident.workflow} failure`,
          detail: `Asked ${answer.label} to investigate run #${incident.runNumber}, attempt ${incident.runAttempt}.`,
          repository: incident.repository,
          taskId: incident.taskId,
          pullRequestId: incident.pullRequestId,
          ciIncidentId: incident.id,
          threadId: answer.id
        })
      }
    }
    if (question.key.startsWith('task-order:')) {
      const taskIds = question.options.filter((option) => option.id !== 'parallel').map((option) => option.id)
      const first = this.tasks.find((task) => taskIds.includes(task.id))
      if (!first) throw new Error('The tasks for that decision are no longer available.')
      const group = taskGroup(first)
      this.taskPlans[group] = {
        mode: answer.id === 'parallel' ? 'parallel' : 'ordered',
        taskIds: answer.id === 'parallel' ? taskIds : [answer.id, ...taskIds.filter((id) => id !== answer.id)],
        updatedAt: this.clock()
      }
      this.reconcileBlockedTasks()
    }
    if (question.key.startsWith('workflow:')) {
      const runId = question.key.split(':')[1]
      const run = this.workflowRuns.find((candidate) => candidate.id === runId)
      if (!run) throw new Error('The managed workflow for that decision is no longer available.')
      const task = this.tasks.find((candidate) => candidate.id === run.taskId)
      run.status = 'stopped'
      run.updatedAt = this.clock()
      run.completedAt = run.updatedAt
      if (task) {
        task.status = answer.id === 'stop' ? 'ready' : (run.stage === 'reviewing' ? 'review' : 'running')
        task.updatedAt = run.updatedAt
        if (answer.id === 'stop') delete task.assignedThreadId
      }
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
    return this.finishMutation()
  }

  async handle(request: BackendRequest): Promise<unknown> {
    if (request.type === 'assistant.snapshot') return this.snapshot()
    if (request.type === 'assistant.answer') return this.answer(request.questionId, request.answerId)
    if (request.type === 'assistant.task.create') return this.createTask(request.input)
    if (request.type === 'assistant.task.update') return this.updateTask(request.taskId, request.patch)
    if (request.type === 'assistant.task.assign') return this.assignTask(request.taskId, request.threadId)
    if (request.type === 'assistant.workflow.configure') return this.configureWorkflow(request.config)
    if (request.type === 'assistant.workflow.start') return this.startWorkflow(request.taskId)
    throw new Error(`Unsupported Lab Assistant request: ${request.type}`)
  }
}
