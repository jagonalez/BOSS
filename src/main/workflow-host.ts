import type { AgentOutcome } from '../shared/workflow'
import type { BackendModeId, BackendRequest } from '../shared/backend'
import type { FileDiff, MessageWithParts } from '../shared/opencode'
import { extractSummary, lastAssistantText } from '../shared/thread-result'
import type { WorktreeInfo } from '../shared/worktree'
import type { BackendManager } from './backend/manager'
import type { NotificationRouter } from './notification-router'
import type { ReviewManager } from './review-manager'
import type { WorktreeManager } from './worktree-manager'
import type { WorkflowAgentRequest, WorkflowHost } from './workflow-engine'

interface WatchedAgent {
  workflowTitle: string
  mode: BackendModeId
  deadlineTimer: NodeJS.Timeout
  pendingPermissions: Map<string, NodeJS.Timeout>
  /** True once the prompt was delivered; idle events before that must not finish the step. */
  sent: boolean
  /** True when an idle event arrived before the prompt delivery resolved. */
  sawIdle: boolean
  notifiedQuestion: boolean
  finished: boolean
}

const PERMISSION_GRACE_MS = 2_500

/**
 * The workflow engine's window onto the rest of BOSS. Owns the full agent
 * conversation lifecycle the way AutomationManager does for automation runs:
 * scoped threads, optional worktrees, unattended permission handling, the
 * run deadline, and outcome collection (summary, last text, changed files).
 * The engine never touches BackendManager directly, which is what keeps it
 * unit-testable.
 */
export class BossWorkflowHost implements WorkflowHost {
  private readonly watched = new Map<string, WatchedAgent>()
  private finishedCallback?: (threadId: string, outcome: AgentOutcome) => void
  private offEvents?: () => void
  private readonly backends: BackendManager
  private readonly worktrees?: WorktreeManager
  private readonly reviews?: ReviewManager
  private readonly notifications?: NotificationRouter
  /** Used when a script names no backend and the workflow has no default. */
  private readonly fallbackBackendId: 'claude' | 'codex' | 'opencode' | 'pi' | 'lab'

  constructor(options: {
    backends: BackendManager
    worktrees?: WorktreeManager
    reviews?: ReviewManager
    notifications?: NotificationRouter
    fallbackBackendId?: 'claude' | 'codex' | 'opencode' | 'pi' | 'lab'
  }) {
    this.backends = options.backends
    this.worktrees = options.worktrees
    this.reviews = options.reviews
    this.notifications = options.notifications
    this.fallbackBackendId = options.fallbackBackendId ?? 'claude'
    this.offEvents = this.backends.onEvent((event) => this.onBackendEvent(event))
  }

  stop(): void {
    this.offEvents?.()
    this.offEvents = undefined
    for (const watch of this.watched.values()) {
      clearTimeout(watch.deadlineTimer)
      for (const timer of watch.pendingPermissions.values()) clearTimeout(timer)
    }
    this.watched.clear()
  }

  onAgentFinished(callback: (threadId: string, outcome: AgentOutcome) => void): void {
    this.finishedCallback = callback
  }

  async startAgent(request: WorkflowAgentRequest): Promise<{ threadId: string; worktreeId?: string }> {
    const backendId = request.options.backendId ?? this.fallbackBackendId
    const workspace = request.options.workspace ?? (request.projectPath ? 'worktree' : 'none')
    // 'none' runs in the global scope: judges and analysis steps have no
    // business holding a checkout.
    let scope = this.backends.scopeFor(workspace === 'none' && !request.options.inWorktreeOf ? '' : request.projectPath)
    let worktree: WorktreeInfo | undefined
    if (request.options.inWorktreeOf) {
      // Share a prior step's checkout: reviewer reads what the implementer
      // wrote, a fix step edits it in place. Ownership stays with the
      // original thread.
      const owner = this.backends.threadInfo(request.options.inWorktreeOf)
      if (!owner) throw new Error('The step whose worktree this one should share no longer exists.')
      scope = { projectId: owner.projectId, projectPath: owner.projectPath, executionPath: owner.executionPath }
    } else if (workspace === 'worktree' && request.projectPath) {
      if (!this.worktrees) throw new Error('Git worktrees are not available.')
      worktree = await this.worktrees.create({
        projectId: scope.projectId,
        projectPath: scope.projectPath,
        sourcePath: scope.projectPath,
        title: request.title
      })
    }
    const thread = await this.backends.createScopedThread(
      backendId,
      worktree ? { ...scope, executionPath: worktree.path } : scope,
      request.title,
      worktree
    )
    if (worktree) await this.worktrees!.setOwner(worktree.id, thread.id)
    const mode = request.options.mode ?? 'auto'
    this.watch(thread.id, {
      workflowTitle: request.title,
      mode,
      deadlineAt: Date.now() + request.maxMinutes * 60_000,
      sent: false
    })
    // The engine journals the thread id now; delivery runs in the background
    // and completion arrives through session events.
    void this.backends
      .handle({
        type: 'thread.send',
        threadId: thread.id,
        parts: [{ type: 'text', text: request.prompt }],
        options: {
          mode,
          model: request.options.model ?? this.backends.defaultModel(backendId),
          strictTools: true
        }
      } satisfies BackendRequest)
      .then(() => {
        const watch = this.watched.get(thread.id)
        if (!watch) return
        watch.sent = true
        // Backends whose send resolves after the work is done already emitted
        // their idle event; it was ignored while sent=false, so finish here.
        if (watch.sawIdle && !this.backends.isThreadBusy(thread.id)) {
          void this.finish(thread.id, 'success')
        }
      })
      .catch((error) => {
        void this.finish(thread.id, 'failure', error instanceof Error ? error.message : String(error))
      })
    return { threadId: thread.id, ...(worktree ? { worktreeId: worktree.id } : {}) }
  }

  /** Re-arm supervision for a thread that was already running before an app
   *  restart: the prompt was delivered in the previous session. */
  watchAgent(threadId: string, deadlineAt: number): void {
    if (this.watched.has(threadId)) return
    this.watch(threadId, { workflowTitle: 'Workflow step', mode: 'auto', deadlineAt, sent: true })
  }

  private watch(threadId: string, input: { workflowTitle: string; mode: BackendModeId; deadlineAt: number; sent: boolean }): void {
    const deadlineTimer = setTimeout(() => void this.onDeadline(threadId), Math.max(1_000, input.deadlineAt - Date.now()))
    deadlineTimer.unref()
    this.watched.set(threadId, {
      workflowTitle: input.workflowTitle,
      mode: input.mode,
      deadlineTimer,
      pendingPermissions: new Map(),
      sent: input.sent,
      sawIdle: false,
      notifiedQuestion: false,
      finished: false
    })
  }

  isAgentActive(threadId: string): boolean {
    return this.backends.isThreadBusy(threadId)
  }

  async collectOutcome(threadId: string): Promise<AgentOutcome | null> {
    try {
      const messages = (await this.backends.handle({ type: 'thread.messages', threadId, limit: 50 })) as MessageWithParts[]
      const text = lastAssistantText(messages)
      if (!text) return null
      return {
        status: 'success',
        summary: extractSummary(messages),
        text,
        changedFiles: await this.changedFiles(threadId),
        threadId
      }
    } catch {
      return null
    }
  }

  async abortAgent(threadId: string): Promise<void> {
    this.unwatch(threadId)
    await this.backends.handle({ type: 'thread.abort', threadId }).catch(() => {})
  }

  notify(notice: { title: string; body: string; attention: boolean }): void {
    this.notifications?.publish({
      type: notice.attention ? 'workflow.needs_attention' : 'workflow.completed',
      title: notice.title,
      body: notice.body,
      createdAt: Date.now()
    })
  }

  async createChangeRequest(
    threadId: string,
    input: { title?: string; body?: string; baseBranch?: string; draft?: boolean }
  ): Promise<unknown> {
    if (!this.reviews) throw new Error('Change requests are not available in this BOSS build.')
    const info = this.backends.threadInfo(threadId)
    if (!info) throw new Error('The agent conversation backing this step no longer exists.')
    return this.reviews.createChangeRequest(info.executionPath, input)
  }

  async deliverToThread(threadId: string, body: string): Promise<void> {
    await this.backends.addFollowUp(threadId, body)
  }

  async disposeThread(threadId: string, worktreeId?: string): Promise<void> {
    await this.backends.handle({ type: 'thread.delete', threadId }).catch(() => {})
    if (worktreeId && this.worktrees) await this.worktrees.remove(worktreeId).catch(() => {})
  }

  // ------------------------------------------------------------- internals

  private onBackendEvent(event: Record<string, unknown>): void {
    const type = String(event.type ?? '')
    const properties = (event.properties ?? {}) as Record<string, unknown>
    const threadId = properties.sessionID as string | undefined
    if (!threadId) return
    const watch = this.watched.get(threadId)
    if (!watch) return
    switch (type) {
      case 'session.idle':
        if (!watch.sent) {
          watch.sawIdle = true
          break
        }
        void this.finish(threadId, 'success')
        break
      case 'session.error': {
        const raw = properties.error
        const detail = typeof raw === 'string' ? raw : raw ? JSON.stringify(raw).slice(0, 500) : 'The backend reported an error.'
        void this.finish(threadId, 'failure', detail)
        break
      }
      case 'permission.asked':
      case 'permission.updated': {
        const permissionId = properties.id as string | undefined
        if (!permissionId || watch.pendingPermissions.has(permissionId)) break
        const timer = setTimeout(() => void this.onPermissionTimeout(threadId, permissionId), PERMISSION_GRACE_MS)
        timer.unref()
        watch.pendingPermissions.set(permissionId, timer)
        break
      }
      case 'permission.replied': {
        const permissionId = properties.permissionID as string | undefined
        if (!permissionId) break
        const timer = watch.pendingPermissions.get(permissionId)
        if (timer) clearTimeout(timer)
        watch.pendingPermissions.delete(permissionId)
        break
      }
      case 'question.asked':
        if (!watch.notifiedQuestion) {
          watch.notifiedQuestion = true
          this.notify({
            title: `BOSS · ${watch.workflowTitle}`,
            body: 'A workflow agent is waiting on a question. Open the thread to answer it.',
            attention: true
          })
        }
        break
      default:
        break
    }
  }

  private async onPermissionTimeout(threadId: string, permissionId: string): Promise<void> {
    const watch = this.watched.get(threadId)
    if (!watch || watch.finished) return
    watch.pendingPermissions.delete(permissionId)
    if (watch.mode === 'ask') {
      // The script asked for a supervised conversation; leave the prompt to
      // the user but make sure they know it exists.
      this.notify({
        title: `BOSS · ${watch.workflowTitle}`,
        body: 'A workflow agent is waiting on a permission prompt.',
        attention: true
      })
      return
    }
    await this.backends
      .handle({ type: 'thread.permission', threadId, permissionId, response: 'once' })
      .catch(() => {})
  }

  private async onDeadline(threadId: string): Promise<void> {
    const watch = this.watched.get(threadId)
    if (!watch || watch.finished) return
    await this.backends.handle({ type: 'thread.abort', threadId }).catch(() => {})
    await this.finish(threadId, 'timeout', 'The step exceeded its time budget and was stopped.')
  }

  private unwatch(threadId: string): WatchedAgent | undefined {
    const watch = this.watched.get(threadId)
    if (!watch) return undefined
    watch.finished = true
    clearTimeout(watch.deadlineTimer)
    for (const timer of watch.pendingPermissions.values()) clearTimeout(timer)
    watch.pendingPermissions.clear()
    this.watched.delete(threadId)
    return watch
  }

  private async finish(threadId: string, status: AgentOutcome['status'], error?: string): Promise<void> {
    const watch = this.unwatch(threadId)
    if (!watch) return
    const outcome: AgentOutcome = {
      status,
      changedFiles: 0,
      threadId,
      ...(error ? { error } : {})
    }
    if (status !== 'failure') {
      try {
        const messages = (await this.backends.handle({ type: 'thread.messages', threadId, limit: 50 })) as MessageWithParts[]
        outcome.summary = extractSummary(messages)
        outcome.text = lastAssistantText(messages)
      } catch {
        /* A missing summary never fails the step. */
      }
      outcome.changedFiles = await this.changedFiles(threadId)
    }
    this.finishedCallback?.(threadId, outcome)
  }

  private async changedFiles(threadId: string): Promise<number> {
    try {
      const diffs = (await this.backends.handle({ type: 'thread.diff', threadId })) as FileDiff[]
      return Array.isArray(diffs) ? diffs.length : 0
    } catch {
      return 0
    }
  }
}
