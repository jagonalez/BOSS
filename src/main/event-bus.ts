import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { BossEvent, WorkflowSubscription } from '../shared/workflow'
// @ts-expect-error Node's type-stripping test runner needs the extension.
import { matchesPattern } from '../shared/workflow.ts'
// @ts-expect-error Node's type-stripping test runner needs the extension.
import { cronError, nextCronTime } from './cron.ts'

interface BusState {
  version: 1
  subscriptions: WorkflowSubscription[]
}

/** Fired when a subscription matches. `event` is null for timer expiries
 *  (sleep deadlines and waitFor timeouts). */
export type SubscriptionHandler = (subscription: WorkflowSubscription, event: BossEvent | null) => void | Promise<void>

const TICK_MS = 30_000

/**
 * The one place events and durable subscriptions meet. Sources (cron, GitHub
 * webhooks, backend events, user actions) publish normalized BossEvents; the
 * workflow engine registers durable subscriptions that either trigger new
 * runs or resume parked ones. Subscriptions survive restarts: they are the
 * "when X happens, wake me" half of durable execution.
 */
export class EventBus {
  private loading?: Promise<void>
  private subscriptions: WorkflowSubscription[] = []
  private handler?: SubscriptionHandler
  private tickTimer?: NodeJS.Timeout
  private readonly now: () => number
  private readonly stateFile: string

  // Node's strip-only TS loader (used by the unit tests) cannot handle
  // parameter properties, hence the explicit assignments.
  constructor(stateFile: string, options?: { now?: () => number }) {
    this.stateFile = stateFile
    this.now = options?.now ?? Date.now
  }

  onFire(handler: SubscriptionHandler): void {
    this.handler = handler
  }

  /** Memoized: concurrent first callers share one read, so a late file read
   *  can never clobber writes made by whoever got in after it. */
  private load(): Promise<void> {
    this.loading ??= (async () => {
      try {
        const parsed = JSON.parse(await readFile(this.stateFile, 'utf8')) as Partial<BusState>
        if (parsed.version === 1 && Array.isArray(parsed.subscriptions)) this.subscriptions = parsed.subscriptions
      } catch {
        /* First launch starts with no subscriptions. */
      }
    })()
    return this.loading
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.stateFile), { recursive: true })
    await writeFile(this.stateFile, JSON.stringify({ version: 1, subscriptions: this.subscriptions } satisfies BusState, null, 2))
  }

  async start(): Promise<void> {
    await this.load()
    await this.tick()
    this.tickTimer = setInterval(() => void this.tick(), TICK_MS)
    this.tickTimer.unref()
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer)
    this.tickTimer = undefined
  }

  async list(): Promise<WorkflowSubscription[]> {
    await this.load()
    return this.subscriptions.map((item) => ({ ...item }))
  }

  async subscribe(input: Omit<WorkflowSubscription, 'id' | 'createdAt'>): Promise<WorkflowSubscription> {
    await this.load()
    if (input.cron) {
      const error = cronError(input.cron.expression)
      if (error) throw new Error(error)
    }
    const subscription: WorkflowSubscription = {
      ...input,
      ...(input.cron ? { cron: { expression: input.cron.expression, nextAt: nextCronTime(input.cron.expression, this.now()) ?? Number.MAX_SAFE_INTEGER } } : {}),
      id: randomUUID(),
      createdAt: this.now()
    }
    this.subscriptions.push(subscription)
    await this.save()
    return { ...subscription }
  }

  async unsubscribe(id: string): Promise<void> {
    await this.load()
    const before = this.subscriptions.length
    this.subscriptions = this.subscriptions.filter((item) => item.id !== id)
    if (this.subscriptions.length !== before) await this.save()
  }

  /** Drop resume subscriptions for steps at or after `minSeq`, used when a
   *  script edit invalidates the tail of a journal: their patterns belong to
   *  steps that no longer exist and must not settle the re-run ones. The
   *  run's deadline timer (negative seq) survives. */
  async unsubscribeResumesFrom(runId: string, minSeq: number): Promise<void> {
    await this.load()
    const before = this.subscriptions.length
    this.subscriptions = this.subscriptions.filter(
      (item) => !(item.target.kind === 'resume' && item.target.runId === runId && item.target.seq >= minSeq)
    )
    if (this.subscriptions.length !== before) await this.save()
  }

  /** Drop every subscription pointing at a run or workflow, e.g. when it is
   *  stopped or deleted. */
  async unsubscribeTarget(match: { runId?: string; workflowId?: string }): Promise<void> {
    await this.load()
    const before = this.subscriptions.length
    this.subscriptions = this.subscriptions.filter((item) => {
      if (match.runId && item.target.kind === 'resume' && item.target.runId === match.runId) return false
      if (match.workflowId && item.target.kind === 'trigger' && item.target.workflowId === match.workflowId) return false
      return true
    })
    if (this.subscriptions.length !== before) await this.save()
  }

  /**
   * Deliver an event to every matching subscription. Resume subscriptions are
   * one-shot and removed before the handler runs, so a handler crash can not
   * double-deliver; trigger subscriptions persist.
   */
  async publish(event: BossEvent): Promise<void> {
    await this.load()
    const matched = this.subscriptions.filter((item) => item.pattern && matchesPattern(item.pattern, event))
    if (matched.length === 0) return
    const oneShot = new Set(matched.filter((item) => item.target.kind === 'resume').map((item) => item.id))
    if (oneShot.size > 0) {
      this.subscriptions = this.subscriptions.filter((item) => !oneShot.has(item.id))
      await this.save()
    }
    for (const subscription of matched) {
      await Promise.resolve(this.handler?.(subscription, event)).catch(() => {})
    }
  }

  /** Fire due cron triggers and expired timers. Public for tests. */
  async tick(): Promise<void> {
    await this.load()
    const now = this.now()
    const fired: { subscription: WorkflowSubscription; event: BossEvent | null }[] = []
    let changed = false
    for (const subscription of this.subscriptions) {
      if (subscription.cron && subscription.cron.nextAt <= now) {
        fired.push({
          subscription,
          event: {
            id: randomUUID(),
            type: 'cron.fired',
            at: now,
            data: { expression: subscription.cron.expression }
          }
        })
        subscription.cron.nextAt = nextCronTime(subscription.cron.expression, now) ?? Number.MAX_SAFE_INTEGER
        changed = true
      }
    }
    const expired = this.subscriptions.filter((item) => item.expiresAt !== undefined && item.expiresAt <= now && !item.cron)
    if (expired.length > 0) {
      const drop = new Set(expired.map((item) => item.id))
      this.subscriptions = this.subscriptions.filter((item) => !drop.has(item.id))
      for (const subscription of expired) fired.push({ subscription, event: null })
      changed = true
    }
    if (changed) await this.save()
    for (const { subscription, event } of fired) {
      await Promise.resolve(this.handler?.(subscription, event)).catch(() => {})
    }
  }
}
