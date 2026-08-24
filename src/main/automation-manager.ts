import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  Automation,
  AutomationInput,
  AutomationRun,
  AutomationRunStatus,
  AutomationRunTrigger,
  AutomationsSnapshot
} from '../shared/automation'
import { AUTOMATION_DEFAULTS } from '../shared/automation'
import type { BackendRequest } from '../shared/backend'
import type { FileDiff, MessageWithParts } from '../shared/opencode'
import { extractSummary, lastAssistantText } from '../shared/thread-result'
import { reportBodyFromAssistantText } from '../shared/report'
import {
  describeWebhookDelivery,
  githubPayloadVariables,
  isWebhookEvent,
  parseGitHubDelivery,
  templatePrompt,
  webhookTriggerMatches
} from '../shared/automation-trigger'
import type { GitHubDelivery } from '../shared/automation-trigger'
import type { NotificationRouter } from './notification-router'
import type { WebhookSettings } from '../shared/notification'
import type { WorktreeInfo } from '../shared/worktree'
import { cronError, missedCronFires, nextCronTime } from './cron'
import type { BackendManager } from './backend/manager'
import type { WorktreeManager } from './worktree-manager'

interface AutomationState {
  version: 1
  automations: Automation[]
  /** POST target for phone push (an ntfy topic URL or any webhook). */
  notifyWebhookUrl?: string
  /** Absent means on: a push is for reaching you away from BOSS. */
  notifyWebhookOnlyWhenAway?: boolean
  /** Per-automation hook secrets, kept out of snapshots so phones and the
   *  relay never see them. */
  webhookTokens?: Record<string, string>
}

interface RunState {
  version: 1
  runs: AutomationRun[]
}

interface ActiveRun {
  run: AutomationRun
  automation: Automation
  timeoutTimer: NodeJS.Timeout
  pendingPermissions: Map<string, NodeJS.Timeout>
  queuedTrigger?: AutomationRunTrigger
  /** True once the prompt was delivered; idle events before that must not finish the run. */
  sent: boolean
  /** True when an idle event arrived before the prompt delivery resolved. */
  sawIdle: boolean
}

interface AutomationManagerOptions {
  stateFile: string
  runsFile: string
}

interface AutomationReports {
  create(automation: Automation, run: AutomationRun, body: string): Promise<{ id: string } | undefined>
  removeForAutomation(automationId: string): Promise<void>
  removeForRuns(runIds: string[]): Promise<void>
}

const TICK_MS = 30_000
const PERMISSION_GRACE_MS = 2_500

function runHeader(automation: Automation, promptVars?: Record<string, string>): string {
  return [
    '[BOSS AUTOMATION RUN]',
    `Automation: ${automation.name}`,
    'This run is unattended. Complete the task below without asking the user questions.',
    'End your final message with exactly one line in this form:',
    'SUMMARY: <one sentence on what you did and what changed>',
    '',
    promptVars ? templatePrompt(automation.prompt, promptVars) : automation.prompt
  ].join('\n')
}

/** What a webhook delivery did to the automation. */
export type WebhookDeliveryResult = 'started' | 'queued' | 'skipped'

/** Carries the HTTP status the hook endpoint should answer with. */
export class WebhookDeliveryError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

export class AutomationManager {
  private loaded = false
  private automations: Automation[] = []
  private notifyWebhookUrl = ''
  private notifyWebhookOnlyWhenAway = true
  private webhookTokens: Record<string, string> = {}
  private hookUrl?: (automationId: string, token: string) => string
  private notifications?: NotificationRouter
  private runs: AutomationRun[] = []
  private readonly active = new Map<string, ActiveRun>()
  private tickTimer?: NodeJS.Timeout
  private offEvents?: () => void
  private webhookObserver?: (delivery: GitHubDelivery) => unknown | Promise<unknown>

  constructor(
    private readonly options: AutomationManagerOptions,
    private readonly backends: BackendManager,
    private readonly worktrees?: WorktreeManager,
    private readonly reports?: AutomationReports
  ) {}

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed = JSON.parse(await readFile(this.options.stateFile, 'utf8')) as Partial<AutomationState>
      if (parsed.version === 1 && Array.isArray(parsed.automations)) {
        this.automations = parsed.automations
        this.notifyWebhookUrl = typeof parsed.notifyWebhookUrl === 'string' ? parsed.notifyWebhookUrl : ''
        this.notifyWebhookOnlyWhenAway = parsed.notifyWebhookOnlyWhenAway !== false
        if (parsed.webhookTokens && typeof parsed.webhookTokens === 'object') {
          this.webhookTokens = Object.fromEntries(
            Object.entries(parsed.webhookTokens).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[1]))
          )
        }
        // Load may finish after the router is attached, so re-apply here.
        this.applyWebhook()
      }
      for (const automation of this.automations) {
        // Migrate the pre-notify-mode boolean field.
        const legacy = automation.notify as unknown
        if (typeof legacy === 'boolean') automation.notify = legacy ? 'events' : 'off'
      }
    } catch {
      /* First launch starts with no automations. */
    }
    try {
      const parsed = JSON.parse(await readFile(this.options.runsFile, 'utf8')) as Partial<RunState>
      if (parsed.version === 1 && Array.isArray(parsed.runs)) this.runs = parsed.runs
    } catch {
      /* First launch starts with no run history. */
    }
    // The previous app session cannot leave a run in 'running'; mark leftovers aborted.
    let changed = false
    for (const run of this.runs) {
      if (run.status === 'running') {
        run.status = 'aborted'
        run.finishedAt = run.finishedAt ?? Date.now()
        run.error = 'The app quit while this run was active.'
        changed = true
      }
    }
    if (changed) await this.save()
  }

  attachNotifications(router: NotificationRouter): void {
    this.notifications = router
    this.applyWebhook()
  }

  /** Mirror the saved webhook into the router.
   *
   *  The URL is still stored with the automation settings, because that is
   *  where users already configured it and moving it would silently drop what
   *  they had. Enabling it for 'attention' matches the old behaviour, where any
   *  automation notification reached the webhook. */
  private webhookSettings(): WebhookSettings {
    return { url: this.notifyWebhookUrl, onlyWhenAway: this.notifyWebhookOnlyWhenAway }
  }

  private applyWebhook(): void {
    this.notifications?.configure({
      webhookUrl: this.notifyWebhookUrl,
      webhook: this.notifyWebhookUrl ? 'attention' : 'off',
      webhookOnlyWhenAway: this.notifyWebhookOnlyWhenAway
    })
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.options.stateFile), { recursive: true })
    const state: AutomationState = {
      version: 1,
      automations: this.automations,
      ...(this.notifyWebhookUrl ? { notifyWebhookUrl: this.notifyWebhookUrl } : {}),
      ...(this.notifyWebhookOnlyWhenAway ? {} : { notifyWebhookOnlyWhenAway: false }),
      ...(Object.keys(this.webhookTokens).length ? { webhookTokens: this.webhookTokens } : {})
    }
    const runState: RunState = { version: 1, runs: this.runs }
    await writeFile(this.options.stateFile, JSON.stringify(state, null, 2))
    await writeFile(this.options.runsFile, JSON.stringify(runState, null, 2))
  }

  /** Lets the hook endpoint hand the manager its public base URL so the
   *  renderer can copy a ready-to-paste webhook address. */
  setHookUrl(build: (automationId: string, token: string) => string): void {
    this.hookUrl = build
  }

  /** Let another durable control plane observe authenticated GitHub events.
   * Observer failures never prevent the configured automation from running. */
  setWebhookObserver(observer: (delivery: GitHubDelivery) => unknown | Promise<unknown>): void {
    this.webhookObserver = observer
  }

  snapshot(): AutomationsSnapshot {
    return {
      automations: this.automations.map((item) => ({ ...item })),
      runs: this.runs.map((item) => ({ ...item }))
    }
  }

  private emitSnapshot(): void {
    this.backends.emit({ type: 'automations.updated', properties: { snapshot: this.snapshot() } })
  }

  private async persistAndEmit(): Promise<void> {
    await this.save()
    this.emitSnapshot()
  }

  async start(): Promise<void> {
    await this.load()
    this.offEvents = this.backends.onEvent((event) => this.onBackendEvent(event))
    await this.catchUp()
    this.tickTimer = setInterval(() => void this.tick(), TICK_MS)
    this.tickTimer.unref()
    this.emitSnapshot()
  }

  async stop(): Promise<void> {
    if (this.tickTimer) clearInterval(this.tickTimer)
    this.tickTimer = undefined
    this.offEvents?.()
    this.offEvents = undefined
    for (const active of [...this.active.values()]) {
      await this.finishRun(active, 'aborted', { error: 'The app quit while this run was active.' }).catch(() => {})
    }
  }

  private async catchUp(): Promise<void> {
    const now = Date.now()
    let changed = false
    for (const automation of this.automations) {
      if (automation.schedule.kind !== 'cron' || !automation.schedule.expression) continue
      const expression = automation.schedule.expression
      if (automation.enabled && automation.nextRunAt && automation.nextRunAt <= now) {
        const missed = missedCronFires(expression, automation.nextRunAt - 1, now)
        if (automation.catchUp && missed > 0) {
          automation.missedRuns += missed - 1
          void this.startRun(automation, 'catch-up')
        } else {
          automation.missedRuns += missed
        }
        changed = true
      }
      const next = nextCronTime(expression, now)
      if (automation.nextRunAt !== (next ?? undefined)) {
        automation.nextRunAt = next ?? undefined
        changed = true
      }
    }
    if (changed) await this.persistAndEmit()
  }

  private async tick(): Promise<void> {
    await this.load()
    const now = Date.now()
    let changed = false
    for (const automation of this.automations) {
      if (!automation.enabled || automation.schedule.kind !== 'cron' || !automation.schedule.expression) continue
      if (!automation.nextRunAt) {
        automation.nextRunAt = nextCronTime(automation.schedule.expression, now) ?? undefined
        changed = true
        continue
      }
      if (automation.nextRunAt > now) continue
      automation.nextRunAt = nextCronTime(automation.schedule.expression, now) ?? undefined
      changed = true
      void this.startRun(automation, 'schedule')
    }
    if (changed) await this.persistAndEmit()
  }

  private normalizeInput(input: AutomationInput): AutomationInput {
    const name = input.name.trim()
    if (!name) throw new Error('Give the automation a name.')
    if (!input.prompt.trim()) throw new Error('Give the automation a prompt.')
    if (input.schedule.kind === 'cron') {
      const error = cronError(input.schedule.expression ?? '')
      if (error) throw new Error(error)
    }
    let webhook: AutomationInput['webhook']
    if (input.webhook) {
      const events = (Array.isArray(input.webhook.events) ? input.webhook.events : []).filter(isWebhookEvent)
      const branch = typeof input.webhook.branch === 'string' ? input.webhook.branch.trim() : ''
      webhook = { events, ...(branch ? { branch } : {}) }
    }
    const projectPath = input.projectPath.trim()
    const workspace = projectPath ? input.workspace : 'none'
    if (workspace === 'worktree' && !this.worktrees) throw new Error('Git worktrees are not available.')
    return {
      ...input,
      name,
      projectPath,
      workspace,
      webhook,
      maxRunMinutes: Math.max(1, Math.min(24 * 60, Math.round(input.maxRunMinutes || AUTOMATION_DEFAULTS.maxRunMinutes))),
      keepRuns: Math.max(1, Math.min(500, Math.round(input.keepRuns || AUTOMATION_DEFAULTS.keepRuns)))
    }
  }

  private ensureWebhookToken(id: string): string {
    const existing = this.webhookTokens[id]
    if (existing) return existing
    const token = randomBytes(24).toString('base64url')
    this.webhookTokens[id] = token
    return token
  }

  private automation(id: string): Automation {
    const found = this.automations.find((item) => item.id === id)
    if (!found) throw new Error('Automation not found.')
    return found
  }

  async create(input: AutomationInput): Promise<Automation> {
    await this.load()
    const clean = this.normalizeInput(input)
    const timestamp = Date.now()
    const automation: Automation = {
      ...clean,
      id: randomUUID(),
      enabled: true,
      missedRuns: 0,
      nextRunAt: clean.schedule.kind === 'cron' && clean.schedule.expression
        ? nextCronTime(clean.schedule.expression, timestamp) ?? undefined
        : undefined,
      createdAt: timestamp,
      updatedAt: timestamp
    }
    if (clean.webhook) this.ensureWebhookToken(automation.id)
    this.automations.push(automation)
    await this.persistAndEmit()
    return { ...automation }
  }

  async update(id: string, patch: Partial<AutomationInput> & { enabled?: boolean }): Promise<Automation> {
    await this.load()
    const automation = this.automation(id)
    const merged = this.normalizeInput({ ...automation, ...patch })
    Object.assign(automation, merged)
    if (!merged.webhook) delete automation.webhook
    if (patch.enabled !== undefined) automation.enabled = patch.enabled
    automation.updatedAt = Date.now()
    automation.missedRuns = 0
    if (automation.webhook) {
      this.ensureWebhookToken(automation.id)
    } else {
      delete this.webhookTokens[automation.id]
    }
    automation.nextRunAt = automation.enabled && automation.schedule.kind === 'cron' && automation.schedule.expression
      ? nextCronTime(automation.schedule.expression, Date.now()) ?? undefined
      : undefined
    await this.persistAndEmit()
    return { ...automation }
  }

  async delete(id: string): Promise<void> {
    await this.load()
    const automation = this.automation(id)
    const active = this.active.get(automation.id)
    if (active) await this.stopRun(automation.id).catch(() => {})
    this.automations = this.automations.filter((item) => item.id !== id)
    this.runs = this.runs.filter((run) => run.automationId !== id)
    delete this.webhookTokens[id]
    if (this.reports) await this.reports.removeForAutomation(id).catch(() => {})
    await this.persistAndEmit()
  }

  async runNow(id: string): Promise<void> {
    await this.load()
    const automation = this.automation(id)
    if (this.active.has(automation.id)) throw new Error('This automation is already running. Stop the active run first.')
    await this.startRun(automation, 'manual')
  }

  async stopRun(id: string): Promise<void> {
    await this.load()
    const active = this.active.get(id)
    if (!active) throw new Error('This automation has no active run.')
    active.queuedTrigger = undefined
    if (active.run.threadId) {
      await this.backends.handle({ type: 'thread.abort', threadId: active.run.threadId }).catch(() => {})
    }
    await this.finishRun(active, 'aborted')
  }

  async handle(request: BackendRequest): Promise<unknown> {
    switch (request.type) {
      case 'automation.list':
        await this.load()
        return this.snapshot()
      case 'automation.create': return this.create(request.input)
      case 'automation.update': return this.update(request.automationId, request.patch)
      case 'automation.delete': return this.delete(request.automationId)
      case 'automation.run': return this.runNow(request.automationId)
      case 'automation.stop': return this.stopRun(request.automationId)
      case 'automation.webhook.get':
        await this.load()
        return this.webhookSettings()
      case 'automation.webhook.set': {
        await this.load()
        if (request.url !== undefined) {
          const url = request.url.trim()
          if (url && !/^https?:\/\//.test(url)) throw new Error('The webhook must be an http(s) URL, e.g. https://ntfy.sh/your-topic.')
          this.notifyWebhookUrl = url
        }
        if (request.onlyWhenAway !== undefined) this.notifyWebhookOnlyWhenAway = request.onlyWhenAway
        await this.save()
        this.applyWebhook()
        return this.webhookSettings()
      }
      case 'automation.webhook.token': {
        await this.load()
        const automation = this.automation(request.automationId)
        if (!automation.webhook) throw new Error('This automation has no GitHub webhook trigger.')
        const token = this.ensureWebhookToken(automation.id)
        return { token, url: this.hookUrl?.(automation.id, token) ?? '' }
      }
      default: throw new Error(`Unsupported automation request: ${request.type}`)
    }
  }

  /**
   * Entry point for the hook endpoint. The token is compared constant-time;
   * unknown ids and unknown tokens are indistinguishable to the caller.
   * Overlap policy and the run budget apply exactly as they do to scheduled
   * runs, because both go through startRun.
   */
  async deliverWebhook(
    id: string,
    token: string,
    eventHeader: string | undefined,
    body: unknown
  ): Promise<WebhookDeliveryResult> {
    await this.load()
    const automation = this.automations.find((item) => item.id === id)
    const stored = this.webhookTokens[id]
    const given = Buffer.from(String(token))
    const expected = Buffer.from(stored ?? '')
    if (!stored || !automation || given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new WebhookDeliveryError('Unknown automation or token.', 404)
    }
    const delivery = parseGitHubDelivery(eventHeader, body)
    if (!delivery) throw new WebhookDeliveryError('The payload must be a JSON object with a GitHub event header.', 400)
    await Promise.resolve(this.webhookObserver?.(delivery)).catch(() => {})
    automation.lastWebhookAt = Date.now()
    automation.lastWebhookLabel = describeWebhookDelivery(delivery)
    await this.persistAndEmit()
    if (!automation.enabled || !webhookTriggerMatches(automation.webhook, delivery)) return 'skipped'
    return this.startRun(automation, 'webhook', githubPayloadVariables(delivery))
  }

  private async startRun(
    automation: Automation,
    trigger: AutomationRunTrigger,
    promptVars?: Record<string, string>
  ): Promise<WebhookDeliveryResult> {
    const existing = this.active.get(automation.id)
    if (existing) {
      if (automation.overlapPolicy === 'queue') {
        existing.queuedTrigger = trigger
        return 'queued'
      }
      this.runs.push({
        id: randomUUID(),
        automationId: automation.id,
        trigger,
        status: 'skipped',
        error: 'The previous run was still active.',
        changedFiles: 0,
        startedAt: Date.now(),
        finishedAt: Date.now()
      })
      await this.persistAndEmit()
      return 'skipped'
    }

    const run: AutomationRun = {
      id: randomUUID(),
      automationId: automation.id,
      trigger,
      status: 'running',
      changedFiles: 0,
      startedAt: Date.now()
    }
    this.runs.push(run)
    automation.lastRunAt = run.startedAt
    automation.missedRuns = 0
    const active: ActiveRun = {
      run,
      automation,
      timeoutTimer: setTimeout(() => void this.onTimeout(automation.id), automation.maxRunMinutes * 60_000),
      pendingPermissions: new Map(),
      sent: false,
      sawIdle: false
    }
    active.timeoutTimer.unref()
    this.active.set(automation.id, active)
    await this.persistAndEmit()

    try {
      const scope = this.backends.scopeFor(automation.projectPath)
      let worktree: WorktreeInfo | undefined
      if (automation.workspace === 'worktree') {
        if (!this.worktrees) throw new Error('Git worktrees are not available.')
        worktree = await this.worktrees.create({
          projectId: scope.projectId,
          projectPath: scope.projectPath,
          sourcePath: scope.projectPath,
          title: automation.name
        })
        run.worktreeId = worktree.id
      }
      const thread = await this.backends.createScopedThread(
        automation.backendId,
        worktree ? { ...scope, executionPath: worktree.path } : scope,
        `${automation.name} · ${new Date(run.startedAt).toLocaleString()}`,
        worktree
      )
      run.threadId = thread.id
      if (worktree) await this.worktrees!.setOwner(worktree.id, thread.id)
      await this.persistAndEmit()
      const preference = automation.model ?? this.backends.defaultModel(automation.backendId)
      await this.backends.handle({
        type: 'thread.send',
        threadId: thread.id,
        parts: [{ type: 'text', text: runHeader(automation, promptVars) }],
        options: {
          mode: automation.mode,
          model: preference ? { providerID: preference.providerID, modelID: preference.modelID } : undefined,
          strictTools: true
        }
      })
      active.sent = true
      // Backends whose send resolves after the work is done already emitted their
      // idle event; it was ignored while sent=false, so finish here instead.
      if (active.run.status === 'running' && active.sawIdle && !this.backends.isThreadBusy(thread.id)) {
        await this.finishRun(active, 'success')
      }
      return 'started'
    } catch (error) {
      await this.finishRun(active, 'failure', {
        error: error instanceof Error ? error.message : String(error)
      })
      return 'started'
    }
  }

  private activeForThread(threadId: string | undefined): ActiveRun | undefined {
    if (!threadId) return undefined
    for (const active of this.active.values()) {
      if (active.run.threadId === threadId) return active
    }
    return undefined
  }

  private onBackendEvent(event: Record<string, unknown>): void {
    const type = String(event.type ?? '')
    const properties = (event.properties ?? {}) as Record<string, unknown>
    const threadId = properties.sessionID as string | undefined
    const active = this.activeForThread(threadId)
    if (!active) return
    switch (type) {
      case 'session.idle':
        if (!active.sent) {
          active.sawIdle = true
          break
        }
        void this.finishRun(active, 'success')
        break
      case 'session.error': {
        const raw = properties.error
        const detail = typeof raw === 'string' ? raw : raw ? JSON.stringify(raw).slice(0, 500) : 'The backend reported an error.'
        void this.finishRun(active, 'failure', { error: detail })
        break
      }
      case 'permission.asked':
      case 'permission.updated': {
        const permissionId = properties.id as string | undefined
        if (!permissionId || active.pendingPermissions.has(permissionId)) break
        const timer = setTimeout(() => void this.onPermissionTimeout(active, permissionId), PERMISSION_GRACE_MS)
        timer.unref()
        active.pendingPermissions.set(permissionId, timer)
        break
      }
      case 'permission.replied': {
        const permissionId = properties.permissionID as string | undefined
        if (!permissionId) break
        const timer = active.pendingPermissions.get(permissionId)
        if (timer) clearTimeout(timer)
        active.pendingPermissions.delete(permissionId)
        break
      }
      case 'question.asked':
        active.run.needsAttention = true
        this.notify(active.automation, `"${active.automation.name}" is waiting on a question. Open the run to answer it.`, true)
        void this.persistAndEmit()
        break
      default:
        break
    }
  }

  private async onPermissionTimeout(active: ActiveRun, permissionId: string): Promise<void> {
    active.pendingPermissions.delete(permissionId)
    if (active.run.status !== 'running' || !active.run.threadId) return
    if (active.automation.mode === 'ask') {
      if (!active.run.needsAttention) {
        active.run.needsAttention = true
        this.notify(active.automation, `"${active.automation.name}" is waiting on a permission prompt.`, true)
        await this.persistAndEmit()
      }
      return
    }
    await this.backends
      .handle({ type: 'thread.permission', threadId: active.run.threadId, permissionId, response: 'once' })
      .catch(() => {})
  }

  private async onTimeout(automationId: string): Promise<void> {
    const active = this.active.get(automationId)
    if (!active || active.run.status !== 'running') return
    if (active.run.threadId) {
      await this.backends.handle({ type: 'thread.abort', threadId: active.run.threadId }).catch(() => {})
    }
    await this.finishRun(active, 'timeout', {
      error: `The run exceeded ${active.automation.maxRunMinutes} minutes and was stopped.`
    })
  }

  private async finishRun(
    active: ActiveRun,
    status: AutomationRunStatus,
    extra?: { error?: string }
  ): Promise<void> {
    if (active.run.status !== 'running') return
    const { run, automation } = active
    run.status = status
    run.finishedAt = Date.now()
    if (extra?.error) run.error = extra.error
    clearTimeout(active.timeoutTimer)
    for (const timer of active.pendingPermissions.values()) clearTimeout(timer)
    active.pendingPermissions.clear()
    this.active.delete(automation.id)

    let reportBody = ''
    if (run.threadId && status !== 'failure') {
      try {
        const messages = (await this.backends.handle({
          type: 'thread.messages',
          threadId: run.threadId,
          limit: 50
        })) as MessageWithParts[]
        run.summary = extractSummary(messages) ?? run.summary
        reportBody = reportBodyFromAssistantText(lastAssistantText(messages))
      } catch {
        /* A missing summary never fails the run. */
      }
      try {
        const diffs = (await this.backends.handle({ type: 'thread.diff', threadId: run.threadId })) as FileDiff[]
        run.changedFiles = Array.isArray(diffs) ? diffs.length : 0
      } catch {
        run.changedFiles = 0
      }
    }

    if (run.worktreeId && run.changedFiles === 0 && this.worktrees) {
      // A clean worktree has no review value; remove() refuses dirty ones, which keeps real changes safe.
      await this.worktrees.remove(run.worktreeId).catch(() => {})
    }

    if (reportBody) {
      const report = await this.reports?.create(automation, run, reportBody).catch(() => undefined)
      if (report) run.reportId = report.id
    }

    if (status === 'failure' || status === 'timeout') {
      this.notify(automation, `"${automation.name}" ${status === 'timeout' ? 'timed out' : 'failed'}${run.error ? `: ${run.error}` : '.'}`, true)
    } else if (status === 'success' && run.changedFiles > 0) {
      this.notify(automation, `"${automation.name}" finished with ${run.changedFiles} changed file${run.changedFiles === 1 ? '' : 's'}.`)
    } else if (status === 'success' && automation.notify === 'always') {
      this.notify(automation, `"${automation.name}": ${run.summary ?? 'finished.'}`)
    }

    await this.pruneRuns(automation)
    await this.persistAndEmit()

    if (active.queuedTrigger) {
      const trigger = active.queuedTrigger
      active.queuedTrigger = undefined
      void this.startRun(automation, trigger)
    }
  }

  private async pruneRuns(automation: Automation): Promise<void> {
    const forAutomation = this.runs
      .filter((run) => run.automationId === automation.id && run.status !== 'running')
      .sort((a, b) => b.startedAt - a.startedAt)
    const excess = forAutomation.slice(automation.keepRuns)
    if (excess.length === 0) return
    const drop = new Set(excess.map((run) => run.id))
    if (this.reports) await this.reports.removeForRuns([...drop]).catch(() => {})
    for (const run of excess) {
      if (run.threadId) {
        await this.backends.handle({ type: 'thread.delete', threadId: run.threadId }).catch(() => {})
      }
      if (run.worktreeId && this.worktrees) {
        await this.worktrees.remove(run.worktreeId).catch(() => {})
      }
    }
    this.runs = this.runs.filter((run) => !drop.has(run.id))
  }

  private notify(automation: Automation, body: string, failed = false): void {
    if (automation.notify === 'off') return
    // The router owns delivery. This used to post to the webhook itself, which
    // is why a thread that needed attention could reach the desktop but never a
    // phone: there were two senders and only one of them knew about webhooks.
    this.notifications?.publish({
      type: failed ? 'automation.failed' : 'automation.completed',
      title: `BOSS · ${automation.name}`,
      body,
      createdAt: Date.now()
    })
  }
}
