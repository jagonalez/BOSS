import { randomUUID } from 'node:crypto'
import vm from 'node:vm'
import type {
  AgentCallOptions,
  AgentOutcome,
  BossEvent,
  JournalEntry,
  JournalOp,
  JudgeCallOptions,
  SubscriptionTarget,
  Workflow,
  WorkflowBudget,
  WorkflowInput,
  WorkflowRun,
  WorkflowRunTrigger,
  WorkflowsSnapshot
} from '../shared/workflow'
import type { EventPattern } from '../shared/workflow'
// @ts-expect-error Node's type-stripping test runner needs the extension.
import { WORKFLOW_BUDGET_DEFAULTS, clampResult, hashArgs, judgePrompt, matchesPattern, parseJudgeOutcome } from '../shared/workflow.ts'
// @ts-expect-error Node's type-stripping test runner needs the extension.
import { cronError } from './cron.ts'
import type { EventBus } from './event-bus'
import type { WorkflowStore } from './workflow-store'

/**
 * Everything the engine needs from the rest of BOSS, kept behind one
 * interface so the engine stays pure logic (and unit-testable). The real
 * adapter wraps BackendManager/WorktreeManager/NotificationRouter/
 * ReviewManager; see workflow-host.ts.
 */
export interface WorkflowAgentRequest {
  runId: string
  seq: number
  workflowId: string
  projectPath: string
  title: string
  prompt: string
  options: AgentCallOptions
  maxMinutes: number
}

export interface WorkflowHost {
  /** Start an agent conversation. Completion arrives via onAgentFinished. */
  startAgent(request: WorkflowAgentRequest): Promise<{ threadId: string; worktreeId?: string }>
  isAgentActive(threadId: string): boolean
  /** Outcome of an inactive thread (it finished while the app was down, or
   *  went idle unobserved). Null when the thread is gone or never answered. */
  collectOutcome(threadId: string): Promise<AgentOutcome | null>
  abortAgent(threadId: string): Promise<void>
  onAgentFinished(callback: (threadId: string, outcome: AgentOutcome) => void): void
  notify(notice: { title: string; body: string; attention: boolean }): void
  /** Optional capabilities; the matching primitive throws when absent. */
  createChangeRequest?(threadId: string, input: { title?: string; body?: string; baseBranch?: string; draft?: boolean }): Promise<unknown>
  /** Delete the durable leftovers of a pruned run. */
  disposeThread?(threadId: string, worktreeId?: string): Promise<void>
}

class BudgetExceededError extends Error {
  constructor(what: string, limit: number) {
    super(`Budget exceeded: this run already used its ${limit} ${what}. Raise the workflow budget or split the work.`)
  }
}

interface LiveExecution {
  runId: string
  nextSeq: number
}

interface Waiter {
  exec: LiveExecution
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

/** The seq used by the whole-run deadline timer subscription. */
const DEADLINE_SEQ = -1
/** Ops whose begin() settles the entry before returning. */
const IMMEDIATE_OPS = new Set<JournalOp>(['notify', 'state.get', 'state.set', 'log', 'pr'])
const JUDGE_RETRY_SUFFIX =
  '\n\nYour previous answer did not end with a valid VERDICT line. Answer again, ending with the REASON and VERDICT lines exactly as specified.'

interface WorkflowEngineOptions {
  now?: () => number
  onSnapshot?: (snapshot: WorkflowsSnapshot) => void
}

/**
 * Durable workflow execution with replay.
 *
 * A run's journal is the source of truth. Executing a run always means
 * running its script from the top: journaled steps return their recorded
 * results instantly, and the first un-journaled step performs live. While
 * the app is up, a script instance simply stays suspended on its pending
 * primitives and is resumed in place (waiters). After a restart, the engine
 * reattaches in-flight steps (live agent threads keep running; vanished ones
 * re-perform; durable wait subscriptions survive in the event bus) and
 * replays the script to exactly where it left off.
 *
 * Known limitation: scripts run on the main process via node:vm, so a script
 * stuck in a synchronous loop blocks the app. The primitives are all async
 * and scripts are user-approved, which keeps this acceptable for now; moving
 * execution to a worker thread is the escape hatch if it ever is not. The
 * Date/Math guards are determinism tripwires for honest scripts, not a
 * security boundary.
 */
export class WorkflowEngine {
  private readonly now: () => number
  private readonly onSnapshot?: (snapshot: WorkflowsSnapshot) => void
  private readonly executions = new Map<string, LiveExecution>()
  private readonly waiters = new Map<string, Waiter>()
  private readonly agentThreads = new Map<string, { runId: string; seq: number }>()
  private started = false
  private stopped = false
  private readonly store: WorkflowStore
  private readonly bus: EventBus
  private readonly host: WorkflowHost

  // Explicit assignments: Node's strip-only TS loader (used by the unit
  // tests) cannot handle parameter properties.
  constructor(store: WorkflowStore, bus: EventBus, host: WorkflowHost, options?: WorkflowEngineOptions) {
    this.store = store
    this.bus = bus
    this.host = host
    this.now = options?.now ?? Date.now
    this.onSnapshot = options?.onSnapshot
    this.bus.onFire((subscription, event) => this.onSubscriptionFired(subscription.target, event))
    this.host.onAgentFinished((threadId, outcome) => void this.onAgentFinished(threadId, outcome))
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    await this.store.load()
    await this.recover()
    await this.bus.start()
    this.emit()
  }

  stop(): void {
    this.stopped = true
    this.bus.stop()
  }

  // ---------------------------------------------------------------- CRUD

  snapshot(): WorkflowsSnapshot {
    return {
      workflows: this.store.workflows.map((item) => ({ ...item })),
      runs: this.store.runs.map((item) => ({ ...item, journal: item.journal.map((entry) => ({ ...entry })) }))
    }
  }

  private emit(): void {
    this.onSnapshot?.(this.snapshot())
  }

  private async persistAndEmit(): Promise<void> {
    // After stop() the engine must not touch disk: in-flight promise chains
    // settling during shutdown would otherwise race the app teardown. State
    // they would have written is rebuilt by recovery on the next start.
    if (this.stopped) return
    await this.store.save()
    this.emit()
  }

  private validate(input: WorkflowInput): WorkflowInput {
    const name = input.name.trim()
    if (!name) throw new Error('Give the workflow a name.')
    if (!input.script.trim()) throw new Error('Give the workflow a script.')
    try {
      this.compileScript(input.script)
    } catch (error) {
      throw new Error(`The script does not parse: ${error instanceof Error ? error.message : String(error)}`)
    }
    for (const trigger of input.triggers) {
      if (trigger.kind === 'cron') {
        const problem = cronError(trigger.expression)
        if (problem) throw new Error(problem)
      } else if (!trigger.pattern.type.trim()) {
        throw new Error('An event trigger needs an event type.')
      }
    }
    return { ...input, name, projectPath: input.projectPath.trim() }
  }

  async create(input: WorkflowInput, source: Workflow['source'] = 'user'): Promise<Workflow> {
    await this.store.load()
    const clean = this.validate(input)
    const timestamp = this.now()
    const workflow: Workflow = {
      ...clean,
      id: randomUUID(),
      enabled: true,
      source,
      createdAt: timestamp,
      updatedAt: timestamp
    }
    this.store.workflows.push(workflow)
    await this.registerTriggers(workflow)
    await this.persistAndEmit()
    return { ...workflow }
  }

  async update(id: string, patch: Partial<WorkflowInput> & { enabled?: boolean }): Promise<Workflow> {
    await this.store.load()
    const workflow = this.store.workflow(id)
    const merged = this.validate({ ...workflow, ...patch })
    Object.assign(workflow, merged)
    if (patch.enabled !== undefined) workflow.enabled = patch.enabled
    workflow.updatedAt = this.now()
    await this.registerTriggers(workflow)
    await this.persistAndEmit()
    return { ...workflow }
  }

  async delete(id: string): Promise<void> {
    await this.store.load()
    const workflow = this.store.workflow(id)
    for (const run of this.store.runs.filter((item) => item.workflowId === id && isActive(item.status))) {
      await this.stopRun(run.id).catch(() => {})
    }
    await this.bus.unsubscribeTarget({ workflowId: id })
    for (const run of this.store.runs.filter((item) => item.workflowId === id)) {
      await this.disposeRun(run)
    }
    this.store.dropWorkflow(workflow.id)
    await this.persistAndEmit()
  }

  /** Keep the bus's trigger subscriptions in sync with the definition. Cron
   *  triggers have no catch-up: a fire missed while the app was closed is
   *  skipped and the next occurrence fires normally. */
  private async registerTriggers(workflow: Workflow): Promise<void> {
    await this.bus.unsubscribeTarget({ workflowId: workflow.id })
    if (!workflow.enabled) return
    for (const trigger of workflow.triggers) {
      if (trigger.kind === 'cron') {
        await this.bus.subscribe({
          target: { kind: 'trigger', workflowId: workflow.id },
          cron: { expression: trigger.expression, nextAt: 0 }
        })
      } else {
        await this.bus.subscribe({
          target: { kind: 'trigger', workflowId: workflow.id },
          pattern: trigger.pattern
        })
      }
    }
  }

  // ---------------------------------------------------------------- runs

  async runNow(workflowId: string, event?: BossEvent): Promise<WorkflowRun> {
    await this.store.load()
    const workflow = this.store.workflow(workflowId)
    return this.startRun(workflow, 'manual', event, { throwOnOverlap: true })
  }

  /** Answer a pending ask() step. */
  async answer(runId: string, seq: number, response: string): Promise<void> {
    await this.store.load()
    const run = this.store.run(runId)
    if (!isActive(run.status)) throw new Error('This run is no longer active.')
    const entry = run.journal.find((item) => item.seq === seq)
    if (!entry || entry.op !== 'ask' || entry.status !== 'started') throw new Error('This run has no pending question at that step.')
    this.settleEntry(run, entry, { result: { answer: response } })
    await this.persistAndEmit()
    this.resumeAfterSettle(run, entry)
  }

  async stopRun(runId: string): Promise<void> {
    await this.store.load()
    const run = this.store.run(runId)
    if (!isActive(run.status)) throw new Error('This run is not active.')
    await this.finishRun(run, 'stopped')
  }

  private async startRun(
    workflow: Workflow,
    trigger: WorkflowRunTrigger,
    event: BossEvent | undefined,
    options?: { throwOnOverlap?: boolean }
  ): Promise<WorkflowRun> {
    const active = this.store.runs.find((item) => item.workflowId === workflow.id && isActive(item.status))
    if (active && workflow.overlapPolicy !== 'parallel') {
      if (options?.throwOnOverlap) throw new Error('This workflow already has an active run. Stop it first.')
      const skipped: WorkflowRun = {
        id: randomUUID(),
        workflowId: workflow.id,
        trigger,
        status: 'skipped',
        ...(event ? { event: clampResult(event) as BossEvent } : {}),
        journal: [],
        usage: { agentRuns: 0, judgeCalls: 0, notifies: 0 },
        error: 'The previous run was still active.',
        startedAt: this.now(),
        finishedAt: this.now()
      }
      this.store.runs.push(skipped)
      await this.persistAndEmit()
      return skipped
    }
    const run: WorkflowRun = {
      id: randomUUID(),
      workflowId: workflow.id,
      trigger,
      status: 'running',
      ...(event ? { event: clampResult(event) as BossEvent } : {}),
      journal: [],
      usage: { agentRuns: 0, judgeCalls: 0, notifies: 0 },
      startedAt: this.now()
    }
    this.store.runs.push(run)
    workflow.lastRunAt = run.startedAt
    const budget = this.budgetFor(workflow)
    await this.bus.subscribe({
      target: { kind: 'resume', runId: run.id, seq: DEADLINE_SEQ },
      expiresAt: run.startedAt + budget.maxRunHours * 3_600_000
    })
    await this.persistAndEmit()
    this.launch(run)
    return { ...run, journal: [...run.journal] }
  }

  private budgetFor(workflow: Workflow): WorkflowBudget {
    return { ...WORKFLOW_BUDGET_DEFAULTS, ...workflow.budget }
  }

  // ------------------------------------------------------------ execution

  /** Compile the script body into an async function of the primitives. */
  private compileScript(script: string): (api: Record<string, unknown>) => Promise<unknown> {
    const source = `(async ({ agent, judge, waitFor, sleep, notify, ask, state, log, pr, event }) => {\n${script}\n})`
    const compiled = new vm.Script(source, { filename: 'workflow.js' })
    const guardedDate = new Proxy(Date, {
      construct(target, args) {
        if (args.length === 0) throw new Error('new Date() is nondeterministic inside a workflow; use event.at or pass times through state.')
        return Reflect.construct(target, args)
      },
      get(target, property, receiver) {
        if (property === 'now') throw new Error('Date.now() is nondeterministic inside a workflow; use event.at or pass times through state.')
        return Reflect.get(target, property, receiver)
      }
    })
    const guardedMath = Object.create(null) as Record<string, unknown>
    for (const key of Object.getOwnPropertyNames(Math)) guardedMath[key] = (Math as unknown as Record<string, unknown>)[key]
    guardedMath.random = () => {
      throw new Error('Math.random() is nondeterministic inside a workflow; derive variation from journaled inputs instead.')
    }
    const context = vm.createContext({ Date: guardedDate, Math: guardedMath, JSON })
    return compiled.runInContext(context) as (api: Record<string, unknown>) => Promise<unknown>
  }

  /** Run (or re-run) a run's script from the top. Fire-and-forget: the
   *  returned promise chain settles the run when the script does. */
  private launch(run: WorkflowRun): void {
    const workflow = this.store.workflows.find((item) => item.id === run.workflowId)
    if (!workflow) return
    const exec: LiveExecution = { runId: run.id, nextSeq: 0 }
    // A relaunch supersedes any prior instance: its pending waiters must
    // never fire into the old closure.
    for (const key of [...this.waiters.keys()]) {
      if (key.startsWith(`${run.id}:`)) this.waiters.delete(key)
    }
    this.executions.set(run.id, exec)
    let fn: (api: Record<string, unknown>) => Promise<unknown>
    try {
      fn = this.compileScript(workflow.script)
    } catch (error) {
      void this.finishRun(run, 'failed', error instanceof Error ? error.message : String(error))
      return
    }
    const api = this.apiFor(workflow, run, exec)
    Promise.resolve()
      .then(() => fn(api))
      .then(
        async (result) => {
          if (this.executions.get(run.id) !== exec || !isActive(run.status)) return
          run.result = clampResult(result)
          await this.finishRun(run, 'completed')
        },
        async (error) => {
          if (this.executions.get(run.id) !== exec || !isActive(run.status)) return
          if (error instanceof BudgetExceededError) {
            await this.finishRun(run, 'needs-attention', error.message)
          } else {
            await this.finishRun(run, 'failed', error instanceof Error ? error.message : String(error))
          }
        }
      )
  }

  private apiFor(workflow: Workflow, run: WorkflowRun, exec: LiveExecution): Record<string, unknown> {
    const budget = this.budgetFor(workflow)
    return {
      event: run.event ? clampResult(run.event) : undefined,
      agent: (prompt: unknown, options?: AgentCallOptions) =>
        this.step(workflow, run, exec, 'agent', { prompt: String(prompt), options: options ?? {} }, async (entry) => {
          if (run.usage.agentRuns >= budget.maxAgentRuns) throw new BudgetExceededError('agent runs', budget.maxAgentRuns)
          run.usage.agentRuns += 1
          await this.beginAgent(workflow, run, entry, budget)
        }),
      judge: (input: unknown, options: unknown, callOptions?: JudgeCallOptions) => {
        const choices = Array.isArray(options) ? options.map(String) : []
        if (choices.length < 2) throw new Error('judge() needs at least two options.')
        return this.step(workflow, run, exec, 'judge', { input: String(input), choices, callOptions: callOptions ?? {} }, async (entry) => {
          if (run.usage.judgeCalls >= budget.maxJudgeCalls) throw new BudgetExceededError('judge calls', budget.maxJudgeCalls)
          run.usage.judgeCalls += 1
          await this.beginJudge(workflow, run, entry, budget)
        })
      },
      waitFor: (pattern: unknown, options?: { timeoutMs?: number }) =>
        this.step(workflow, run, exec, 'wait', { pattern, timeoutMs: options?.timeoutMs }, async (entry) => {
          const args = entry.args as { pattern: BossEvent extends never ? never : { type: string }; timeoutMs?: number }
          if (!args.pattern || typeof args.pattern !== 'object' || !('type' in args.pattern)) {
            throw new Error('waitFor() needs an event pattern with a type.')
          }
          await this.bus.subscribe({
            target: { kind: 'resume', runId: run.id, seq: entry.seq },
            pattern: args.pattern as never,
            ...(args.timeoutMs ? { expiresAt: entry.startedAt + args.timeoutMs } : {})
          })
        }),
      sleep: (ms: unknown) =>
        this.step(workflow, run, exec, 'sleep', { ms: Number(ms) }, async (entry) => {
          const args = entry.args as { ms: number }
          if (!Number.isFinite(args.ms) || args.ms <= 0) throw new Error('sleep() needs a positive number of milliseconds.')
          await this.bus.subscribe({
            target: { kind: 'resume', runId: run.id, seq: entry.seq },
            expiresAt: entry.startedAt + args.ms
          })
        }),
      notify: (body: unknown, options?: { title?: string; attention?: boolean }) =>
        this.step(workflow, run, exec, 'notify', { body: String(body), options: options ?? {} }, async (entry) => {
          if (run.usage.notifies >= budget.maxNotifies) throw new BudgetExceededError('notifications', budget.maxNotifies)
          run.usage.notifies += 1
          const args = entry.args as { body: string; options: { title?: string; attention?: boolean } }
          this.host.notify({
            title: args.options.title ?? `BOSS · ${workflow.name}`,
            body: args.body,
            attention: args.options.attention === true
          })
          this.settleEntry(run, entry, { result: null })
        }),
      ask: (question: unknown, choices?: unknown) =>
        this.step(workflow, run, exec, 'ask', { question: String(question), choices: Array.isArray(choices) ? choices.map(String) : undefined }, async (entry) => {
          const args = entry.args as { question: string }
          this.host.notify({
            title: `BOSS · ${workflow.name}`,
            body: `Waiting on you: ${args.question}`,
            attention: true
          })
        }).then((value) => (value as { answer: string }).answer),
      state: {
        get: (key: unknown) =>
          this.step(workflow, run, exec, 'state.get', { key: String(key) }, async (entry) => {
            this.settleEntry(run, entry, { result: this.store.memoryGet(workflow.id, String(key)) })
          }),
        set: (key: unknown, value: unknown) =>
          this.step(workflow, run, exec, 'state.set', { key: String(key), value: clampResult(value) }, async (entry) => {
            const args = entry.args as { key: string; value: unknown }
            this.store.memorySet(workflow.id, args.key, args.value)
            this.settleEntry(run, entry, { result: null })
          })
      },
      log: (message: unknown) =>
        this.step(workflow, run, exec, 'log', { message: String(message) }, async (entry) => {
          this.settleEntry(run, entry, { result: null })
        }),
      pr: (from: unknown, options?: { title?: string; body?: string; baseBranch?: string; draft?: boolean }) => {
        const threadId = typeof from === 'object' && from !== null ? String((from as { threadId?: unknown }).threadId ?? '') : ''
        return this.step(workflow, run, exec, 'pr', { threadId, options: options ?? {} }, async (entry) => {
          if (!this.host.createChangeRequest) throw new Error('Change requests are not available in this BOSS build.')
          const args = entry.args as { threadId: string; options: { title?: string; body?: string; baseBranch?: string; draft?: boolean } }
          if (!args.threadId) throw new Error('pr() needs the agent outcome whose worktree holds the commits, e.g. pr(impl, {...}).')
          const result = await this.host.createChangeRequest(args.threadId, args.options)
          this.settleEntry(run, entry, { result: clampResult(result) })
        })
      }
    }
  }

  /**
   * The one replay-aware primitive wrapper. Synchronously consults the
   * journal, then either returns the recorded result, awaits the in-flight
   * step, or performs it live. `begin` must either start durable work whose
   * completion later calls settleEntry (agent, judge, wait, sleep, ask) or
   * settle the entry itself before returning (notify, state, log, pr).
   */
  private step(
    workflow: Workflow,
    run: WorkflowRun,
    exec: LiveExecution,
    op: JournalOp,
    args: unknown,
    begin: (entry: JournalEntry) => Promise<void>
  ): Promise<unknown> {
    if (this.executions.get(run.id) !== exec) return new Promise(() => {})
    const seq = exec.nextSeq
    exec.nextSeq += 1
    const clampedArgs = clampResult(args)
    const argsHash = hashArgs(op, clampedArgs)
    let entry = run.journal.find((item) => item.seq === seq)
    let invalidatedFrom: number | undefined
    if (entry && (entry.op !== op || entry.argsHash !== argsHash)) {
      // The script changed since this journal was written. Everything from
      // here on no longer matches; drop it and continue live. Earlier steps
      // keep their results — this is what makes editing a workflow mid-run
      // safe.
      run.journal = run.journal.filter((item) => item.seq < seq)
      run.note = `The script changed; steps from #${seq} re-ran on ${new Date(this.now()).toLocaleString()}.`
      invalidatedFrom = seq
      entry = undefined
    }
    if (entry && entry.status === 'started' && IMMEDIATE_OPS.has(op)) {
      // An immediate step interrupted mid-write (app quit between perform and
      // persist). Its effect is idempotent or harmless to repeat: re-perform.
      run.journal = run.journal.filter((item) => item.seq !== seq)
      entry = undefined
    }
    if (entry) {
      if (entry.status !== 'started') return this.replayedOutcome(entry)
      // In flight: wait for its completion, reattaching whatever backs it.
      const waiter = this.waiterFor(run, exec, seq)
      void this.reattach(workflow, run, entry).catch((error) => {
        this.settleEntry(run, entry!, { error: error instanceof Error ? error.message : String(error) })
        void this.persistAndEmit()
        this.resumeAfterSettle(run, entry!)
      })
      return waiter
    }
    const fresh: JournalEntry = {
      seq,
      op,
      argsHash,
      args: clampedArgs,
      label: labelFor(op, clampedArgs),
      status: 'started',
      startedAt: this.now()
    }
    run.journal.push(fresh)
    this.refreshStatus(run)
    const waiter = this.waiterFor(run, exec, seq)
    void (async () => {
      try {
        // Waits journaled by the dropped tail must not settle the new steps.
        if (invalidatedFrom !== undefined) await this.bus.unsubscribeResumesFrom(run.id, invalidatedFrom)
        await begin(fresh)
        await this.persistAndEmit()
        // Immediate ops settle inside begin(); hand the script its result.
        if (fresh.status !== 'started') this.resumeAfterSettle(run, fresh)
      } catch (error) {
        this.settleEntry(run, fresh, { error: error instanceof Error ? error.message : String(error), budget: error instanceof BudgetExceededError })
        await this.persistAndEmit()
        this.resumeAfterSettle(run, fresh)
      }
    })()
    return waiter
  }

  /** The recorded outcome of a settled entry, as the script sees it. */
  private replayedOutcome(entry: JournalEntry): Promise<unknown> {
    if (entry.status === 'done') return Promise.resolve(entry.result ?? null)
    return Promise.reject(errorFromEntry(entry))
  }

  /** Register the promise a live script instance suspends on for a step. */
  private waiterFor(run: WorkflowRun, exec: LiveExecution, seq: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.waiters.set(`${run.id}:${seq}`, { exec, resolve, reject })
    })
  }

  /** Record a step outcome on its journal entry. */
  private settleEntry(run: WorkflowRun, entry: JournalEntry, outcome: { result?: unknown; error?: string; budget?: boolean }): void {
    if (entry.status !== 'started') return
    if (outcome.error !== undefined) {
      entry.status = 'failed'
      entry.error = outcome.budget ? `[budget] ${outcome.error}` : outcome.error
    } else {
      entry.status = 'done'
      entry.result = clampResult(outcome.result)
    }
    entry.finishedAt = this.now()
    if (entry.threadId) this.agentThreads.delete(entry.threadId)
    this.refreshStatus(run)
  }

  /** Hand a settled step's outcome to the script — or, when no script
   *  instance is live (just after a restart), replay the run to get one. */
  private resumeAfterSettle(run: WorkflowRun, entry: JournalEntry): void {
    const waiter = this.waiters.get(`${run.id}:${entry.seq}`)
    if (waiter && this.executions.get(run.id) === waiter.exec) {
      this.waiters.delete(`${run.id}:${entry.seq}`)
      if (entry.status === 'failed') waiter.reject(errorFromEntry(entry))
      else waiter.resolve(entry.result ?? null)
      return
    }
    if (isActive(run.status)) this.launch(run)
  }

  /** Derive the run status from what its journal is currently doing. */
  private refreshStatus(run: WorkflowRun): void {
    if (!isActive(run.status)) return
    const inFlight = run.journal.filter((item) => item.status === 'started')
    run.status = inFlight.some((item) => item.op === 'agent' || item.op === 'judge' || item.op === 'pr') ? 'running' : inFlight.length > 0 ? 'waiting' : 'running'
  }

  // ------------------------------------------------------ agents & judges

  private async beginAgent(workflow: Workflow, run: WorkflowRun, entry: JournalEntry, budget: WorkflowBudget): Promise<void> {
    const args = entry.args as { prompt: string; options: AgentCallOptions }
    const options: AgentCallOptions = {
      ...(workflow.defaults?.backendId ? { backendId: workflow.defaults.backendId } : {}),
      ...(workflow.defaults?.model ? { model: workflow.defaults.model } : {}),
      ...args.options
    }
    const { threadId, worktreeId } = await this.host.startAgent({
      runId: run.id,
      seq: entry.seq,
      workflowId: workflow.id,
      projectPath: workflow.projectPath,
      title: options.title ?? `${workflow.name} · step ${entry.seq}`,
      prompt: agentHeader(workflow.name, args.prompt),
      options,
      maxMinutes: Math.min(options.maxMinutes ?? budget.maxAgentMinutes, budget.maxAgentMinutes)
    })
    entry.threadId = threadId
    if (worktreeId) entry.worktreeId = worktreeId
    this.agentThreads.set(threadId, { runId: run.id, seq: entry.seq })
  }

  private async beginJudge(workflow: Workflow, run: WorkflowRun, entry: JournalEntry, budget: WorkflowBudget, retry = false): Promise<void> {
    const args = entry.args as { input: string; choices: string[]; callOptions: JudgeCallOptions }
    const prompt = judgePrompt(args.input, args.choices, args.callOptions.rubric) + (retry ? JUDGE_RETRY_SUFFIX : '')
    const options: AgentCallOptions = {
      workspace: 'none',
      mode: 'auto',
      backendId: args.callOptions.backendId ?? workflow.defaults?.judgeBackendId ?? workflow.defaults?.backendId,
      model: args.callOptions.model ?? workflow.defaults?.judgeModel ?? workflow.defaults?.model
    }
    const { threadId } = await this.host.startAgent({
      runId: run.id,
      seq: entry.seq,
      workflowId: workflow.id,
      projectPath: workflow.projectPath,
      title: `${workflow.name} · judge ${entry.seq}`,
      prompt,
      options,
      maxMinutes: Math.min(10, budget.maxAgentMinutes)
    })
    entry.threadId = threadId
    entry.attempts = (entry.attempts ?? 0) + 1
    this.agentThreads.set(threadId, { runId: run.id, seq: entry.seq })
  }

  private async onAgentFinished(threadId: string, outcome: AgentOutcome): Promise<void> {
    const location = this.agentThreads.get(threadId)
    if (!location) return
    this.agentThreads.delete(threadId)
    const run = this.store.runs.find((item) => item.id === location.runId)
    if (!run || !isActive(run.status)) return
    const entry = run.journal.find((item) => item.seq === location.seq)
    if (!entry || entry.status !== 'started' || entry.threadId !== threadId) return
    await this.settleAgentEntry(run, entry, outcome)
  }

  private async settleAgentEntry(run: WorkflowRun, entry: JournalEntry, outcome: AgentOutcome): Promise<void> {
    if (entry.op === 'judge') {
      const workflow = this.store.workflows.find((item) => item.id === run.workflowId)
      const args = entry.args as { choices: string[] }
      const parsed = outcome.status === 'success' ? parseJudgeOutcome(outcome.text ?? outcome.summary, args.choices) : null
      if (parsed) {
        this.settleEntry(run, entry, { result: parsed })
      } else if (outcome.status === 'success' && (entry.attempts ?? 1) < 2 && workflow) {
        // One retry with a firmer contract before giving up on the verdict.
        run.usage.judgeCalls += 1
        await this.beginJudge(workflow, run, entry, this.budgetFor(workflow), true).catch((error) => {
          this.settleEntry(run, entry, { error: error instanceof Error ? error.message : String(error) })
        })
        await this.persistAndEmit()
        if (entry.status !== 'started') this.resumeAfterSettle(run, entry)
        return
      } else {
        this.settleEntry(run, entry, {
          error:
            outcome.status === 'success'
              ? 'The judge never produced a valid VERDICT line.'
              : outcome.error ?? `The judge conversation ended with status ${outcome.status}.`
        })
      }
    } else {
      this.settleEntry(run, entry, { result: outcome })
    }
    await this.persistAndEmit()
    this.resumeAfterSettle(run, entry)
  }

  // ------------------------------------------------------------- resume

  private async onSubscriptionFired(target: SubscriptionTarget, event: BossEvent | null): Promise<void> {
    await this.store.load()
    if (target.kind === 'trigger') {
      const workflow = this.store.workflows.find((item) => item.id === target.workflowId)
      if (!workflow || !workflow.enabled || !event) return
      await this.startRun(workflow, event.type === 'cron.fired' ? 'cron' : 'event', event)
      return
    }
    const run = this.store.runs.find((item) => item.id === target.runId)
    if (!run || !isActive(run.status)) return
    if (target.seq === DEADLINE_SEQ) {
      await this.finishRun(run, 'needs-attention', 'The run exceeded its wall-clock budget.')
      return
    }
    const entry = run.journal.find((item) => item.seq === target.seq)
    if (!entry || entry.status !== 'started') return
    // The journal is the source of truth: a delivery must match the entry's
    // own recorded pattern. This shields a re-journaled step from a stale
    // subscription left by a since-edited script.
    if (entry.op === 'wait') {
      const args = entry.args as { pattern?: EventPattern; timeoutMs?: number }
      if (event && (!args.pattern || !matchesPattern(args.pattern, event))) return
      if (!event && args.timeoutMs === undefined) return
    } else if (entry.op === 'sleep') {
      if (event) return
    } else {
      return
    }
    this.settleEntry(run, entry, { result: event ? clampResult(event) : null })
    await this.persistAndEmit()
    this.resumeAfterSettle(run, entry)
  }

  /** Reattach an in-flight journal entry found during replay: rewire live
   *  agent threads, collect outcomes that arrived while the app was down,
   *  re-perform vanished work, and re-register lost wait subscriptions. */
  private async reattach(workflow: Workflow, run: WorkflowRun, entry: JournalEntry): Promise<void> {
    const budget = this.budgetFor(workflow)
    if (entry.op === 'agent' || entry.op === 'judge') {
      if (entry.threadId && this.host.isAgentActive(entry.threadId)) {
        this.agentThreads.set(entry.threadId, { runId: run.id, seq: entry.seq })
        return
      }
      if (entry.threadId) {
        const outcome = await this.host.collectOutcome(entry.threadId)
        if (outcome) {
          await this.settleAgentEntry(run, entry, outcome)
          return
        }
      }
      // The conversation is gone (or never started): re-perform the step in
      // a fresh thread. This is the "restart the stage" recovery.
      if (entry.op === 'agent') await this.beginAgent(workflow, run, entry, budget)
      else await this.beginJudge(workflow, run, entry, budget)
      await this.persistAndEmit()
      return
    }
    if (entry.op === 'wait' || entry.op === 'sleep') {
      const existing = (await this.bus.list()).some(
        (item) => item.target.kind === 'resume' && item.target.runId === run.id && item.target.seq === entry.seq
      )
      if (existing) return
      const args = entry.args as { pattern?: { type: string }; timeoutMs?: number; ms?: number }
      const expiresAt = entry.op === 'sleep' ? entry.startedAt + (args.ms ?? 0) : args.timeoutMs ? entry.startedAt + args.timeoutMs : undefined
      if (expiresAt !== undefined && expiresAt <= this.now()) {
        this.settleEntry(run, entry, { result: null })
        await this.persistAndEmit()
        this.resumeAfterSettle(run, entry)
        return
      }
      await this.bus.subscribe({
        target: { kind: 'resume', runId: run.id, seq: entry.seq },
        ...(args.pattern ? { pattern: args.pattern as never } : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {})
      })
      return
    }
    // 'ask' needs nothing: the pending question survives in the journal and
    // answer() settles it whenever the user responds.
  }

  /** Rebuild live state for every unfinished run after an app start. */
  private async recover(): Promise<void> {
    const active = this.store.runs.filter((item) => isActive(item.status))
    for (const run of active) {
      this.launch(run)
    }
    // Trigger subscriptions live in the bus state file; recreate them in
    // case the definition changed while a previous app version was running.
    for (const workflow of this.store.workflows) {
      if (workflow.enabled) await this.registerTriggers(workflow)
    }
    if (active.length > 0) await this.persistAndEmit()
  }

  private async finishRun(run: WorkflowRun, status: 'completed' | 'failed' | 'stopped' | 'needs-attention', error?: string): Promise<void> {
    if (!isActive(run.status)) return
    run.status = status
    if (error) run.error = error
    run.finishedAt = this.now()
    // Notify in the same tick as the status flip, before any async cleanup:
    // whoever observes the terminal status must also find the notification.
    const workflow = this.store.workflows.find((item) => item.id === run.workflowId)
    if (status === 'failed' || status === 'needs-attention') {
      this.host.notify({
        title: `BOSS · ${workflow?.name ?? 'Workflow'}`,
        body: status === 'failed' ? `The run failed: ${error ?? 'unknown error.'}` : error ?? 'The run needs your attention.',
        attention: true
      })
    }
    this.executions.delete(run.id)
    for (const key of [...this.waiters.keys()]) {
      if (key.startsWith(`${run.id}:`)) this.waiters.delete(key)
    }
    for (const entry of run.journal) {
      if (entry.status === 'started' && entry.threadId) {
        this.agentThreads.delete(entry.threadId)
        if (status !== 'completed') await this.host.abortAgent(entry.threadId).catch(() => {})
      }
    }
    await this.bus.unsubscribeTarget({ runId: run.id })
    if (workflow) {
      const prune = this.store.pruneCandidates(workflow.id)
      for (const old of prune) {
        await this.disposeRun(old)
      }
      this.store.dropRuns(new Set(prune.map((item) => item.id)))
    }
    await this.persistAndEmit()
  }

  private async disposeRun(run: WorkflowRun): Promise<void> {
    if (!this.host.disposeThread) return
    for (const entry of run.journal) {
      if (entry.threadId) await this.host.disposeThread(entry.threadId, entry.worktreeId).catch(() => {})
    }
  }
}

function isActive(status: WorkflowRun['status']): boolean {
  return status === 'running' || status === 'waiting'
}

/** Reconstruct a step failure for the script, preserving budget semantics
 *  across journal replay so a replayed budget failure still ends the run as
 *  needs-attention rather than failed. */
function errorFromEntry(entry: JournalEntry): Error {
  const message = entry.error ?? 'This step failed.'
  if (message.startsWith('[budget]')) {
    const error = new BudgetExceededError('', 0)
    error.message = message
    return error
  }
  return new Error(message)
}

function agentHeader(workflowName: string, prompt: string): string {
  return [
    '[BOSS WORKFLOW STEP]',
    `Workflow: ${workflowName}`,
    'This run is unattended. Complete the task below without asking the user questions.',
    'End your final message with exactly one line in this form:',
    'SUMMARY: <one sentence on what you did and what changed>',
    '',
    prompt
  ].join('\n')
}

function labelFor(op: JournalOp, args: unknown): string {
  const record = (args ?? {}) as Record<string, unknown>
  const text =
    op === 'agent'
      ? String(record.prompt ?? '')
      : op === 'judge'
        ? String(record.input ?? '')
        : op === 'wait'
          ? `waiting for ${String((record.pattern as { type?: string } | undefined)?.type ?? 'event')}`
          : op === 'ask'
            ? String(record.question ?? '')
            : op === 'notify' || op === 'log'
              ? String(record.body ?? record.message ?? '')
              : op === 'sleep'
                ? `sleeping ${String(record.ms)}ms`
                : op
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 80 ? `${flat.slice(0, 77)}…` : flat
}
