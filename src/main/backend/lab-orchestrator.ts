import type { LabSessionStore } from './lab-session-store'

/** Tools the orchestrator executes: they manage sub-agents, not files or
 *  commands, so they live here rather than in runTool. */
export const ORCHESTRATION_TOOL_NAMES = new Set(['spawn_subagent', 'list_subagents', 'wait_subagent', 'wait_subagents', 'abort_subagent'])

export function isOrchestrationTool(name: string): boolean {
  return ORCHESTRATION_TOOL_NAMES.has(name)
}

export interface ChildTurnOutcome {
  status: 'completed' | 'error' | 'interrupted'
  error?: string
}

export interface ChildLaunchRequest {
  sessionId: string
  instruction: string
  model: string
  cwd: string
  /** The child's own kill switch, so abort_subagent can stop it. */
  controller: AbortController
  /** Combined with the parent's signal so stopping the parent cancels the
   *  whole tree. */
  signal: AbortSignal
  /** System-prompt context injected into the child's turn. */
  context: string
}

export interface OrchestratorOptions {
  maxTotal?: number
  maxActive?: number
}

/** Runs a sub-agent turn. The backend supplies this by routing to its own
 *  agent loop with status events suppressed. */
export type RunChild = (request: ChildLaunchRequest) => Promise<ChildTurnOutcome>

const DEFAULT_MAX_TOTAL = 8
const DEFAULT_MAX_ACTIVE = 4

/** Multi-agent orchestration for Lab: sessions carry a parent link, and this
 *  module turns that into a team. A parent spawns sub-agents (blocking, or in
 *  the background with wait:false), collects their summaries with
 *  wait_subagent, inspects them with list_subagents, and stops them with
 *  abort_subagent. Stopping the parent cancels its whole tree; deleting the
 *  parent disposes every child.
 *
 *  Kept apart from the backend so the team semantics (budgets, background
 *  collection, abort) are unit-testable with a fake runner and so the backend
 *  file stays about the harness, not the org chart. */
export class LabOrchestrator {
  private readonly store: LabSessionStore
  private readonly runChild: RunChild
  private readonly maxTotal: number
  private readonly maxActive: number
  private readonly childTurnPromises = new Map<string, Promise<ChildTurnOutcome>>()
  private readonly controllers = new Map<string, AbortController>()

  constructor(
    store: LabSessionStore,
    runChild: RunChild,
    options: OrchestratorOptions = {}
  ) {
    this.store = store
    this.runChild = runChild
    this.maxTotal = options.maxTotal ?? DEFAULT_MAX_TOTAL
    this.maxActive = options.maxActive ?? DEFAULT_MAX_ACTIVE
  }

  /** Team tools entry point. Returns the text the parent sees as the result. */
  async execute(
    parentSessionId: string,
    name: string,
    args: Record<string, unknown>,
    opts: { model: string; cwd: string; parentSignal: AbortSignal }
  ): Promise<string> {
    switch (name) {
      case 'spawn_subagent':
        return this.spawnSubagent(parentSessionId, args, opts)
      case 'wait_subagent':
        return this.waitSubagent(parentSessionId, String(args.subagent_id ?? ''))
      case 'wait_subagents':
        return this.waitSubagents(parentSessionId, Array.isArray(args.subagent_ids) ? args.subagent_ids.map(String) : undefined)
      case 'list_subagents':
        return this.listSubagents(parentSessionId)
      case 'abort_subagent':
        return this.abortSubagent(parentSessionId, String(args.subagent_id ?? ''))
      default:
        return `Unknown orchestration tool: ${name}`
    }
  }

  listSubagents(parentSessionId: string): string {
    return JSON.stringify(
      this.store.childrenOf(parentSessionId).map((record) => this.store.subAgentSummary(record)),
      null,
      2
    )
  }

  async waitSubagent(parentSessionId: string, subagentId: string): Promise<string> {
    const child = this.store.childrenOf(parentSessionId).find((record) => record.id === subagentId)
    if (!child) return `No sub-agent found with id ${subagentId}.`
    const pending = this.childTurnPromises.get(subagentId)
    if (pending) {
      const outcome = await pending
      return outcome.status === 'completed'
        ? `Sub-agent ${subagentId} completed.\n\nFinal summary:\n${this.store.lastAssistantText(subagentId) || '(no summary text)'}`
        : `Sub-agent ${subagentId} ${outcome.status === 'interrupted' ? 'was interrupted' : 'failed'}: ${outcome.error ?? 'see transcript.'}`
    }
    const record = this.store.get(subagentId)
    if (record.status === 'completed') {
      return `Sub-agent ${subagentId} already completed.\n\nFinal summary:\n${this.store.lastAssistantText(subagentId) || '(no summary text)'}`
    }
    return `Sub-agent ${subagentId} is not running (status: ${record.status ?? 'idle'}).`
  }

  /** Wait for every listed sub-agent (or all of the parent's, when none are
   *  given) and return their results together — the fan-out collection step.
   *  Background workers spawned with wait=false run concurrently, so this is
   *  how a parent gathers a whole batch at once. */
  async waitSubagents(parentSessionId: string, ids?: string[]): Promise<string> {
    const children = this.store.childrenOf(parentSessionId)
    const targets = ids && ids.length > 0 ? children.filter((record) => ids.includes(record.id)) : children
    if (targets.length === 0) return '[]'
    const pending = targets.map((record) => this.childTurnPromises.get(record.id) ?? Promise.resolve({ status: record.status ?? 'idle' }))
    const outcomes = await Promise.allSettled(pending)
    return JSON.stringify(targets.map((record, index) => {
      const settled = outcomes[index]
      const status = settled.status === 'fulfilled' && settled.value.status === 'completed' ? 'completed' : 'error'
      return {
        id: record.id,
        title: record.title ?? 'Untitled',
        status,
        ...(status === 'completed' ? { summary: this.store.lastAssistantText(record.id) } : {})
      }
    }), null, 2)
  }

  abortSubagent(parentSessionId: string, subagentId: string): string {
    const child = this.store.childrenOf(parentSessionId).find((record) => record.id === subagentId)
    if (!child) return `No sub-agent found with id ${subagentId}.`
    const wasRunning = this.controllers.has(subagentId)
    this.controllers.get(subagentId)?.abort()
    this.store.setStatus(subagentId, 'aborted')
    return wasRunning ? `Stopping sub-agent ${subagentId}.` : `Sub-agent ${subagentId} is not running; marked aborted.`
  }

  async spawnSubagent(
    parentSessionId: string,
    args: Record<string, unknown>,
    opts: { model: string; cwd: string; parentSignal: AbortSignal }
  ): Promise<string> {
    const instruction = String(args.instruction ?? '').trim()
    if (!instruction) return 'spawn_subagent requires an instruction.'
    const children = this.store.childrenOf(parentSessionId)
    if (children.length >= this.maxTotal) {
      return `This thread already spawned ${this.maxTotal} sub-agents. Reuse them or wait for one to finish.`
    }
    const active = children.filter((record) => record.status === 'running').length
    if (active >= this.maxActive) {
      return `Too many sub-agents are running right now (max ${this.maxActive}). Wait for one with wait_subagent first.`
    }
    const wait = args.wait !== false
    const title = String(args.title ?? '').trim()
    const child = this.store.createParented(title || undefined, opts.cwd, parentSessionId)
    this.store.setStatus(child.id, 'running')
    const controller = new AbortController()
    this.controllers.set(child.id, controller)
    const signal = AbortSignal.any([opts.parentSignal, controller.signal])
    const context = [
      'You are a delegated sub-agent running inside BOSS.',
      'Drive the task autonomously, working only inside the project directory.',
      'Report a concise final summary: what you changed and how you verified it.'
    ].join(' ')
    const run = this.runChild({
      sessionId: child.id,
      instruction,
      model: opts.model,
      cwd: opts.cwd,
      controller,
      signal,
      context
    })
    this.childTurnPromises.set(child.id, run)
    const settle = async (): Promise<'completed' | 'aborted' | 'error'> => {
      const outcome = await run
      this.childTurnPromises.delete(child.id)
      this.controllers.delete(child.id)
      const status = outcome.status === 'completed' ? 'completed' : outcome.status === 'interrupted' ? 'aborted' : 'error'
      this.store.setStatus(child.id, status)
      return status
    }
    if (!wait) {
      void settle()
      return `Spawned sub-agent "${title || instruction.slice(0, 40)}" (${child.id}) in the background. Collect it with wait_subagent or check status with list_subagents.`
    }
    const status = await settle()
    if (status !== 'completed') {
      return `Sub-agent ${child.id} ${status === 'aborted' ? 'was interrupted' : 'failed'}: see transcript.`
    }
    return `Sub-agent "${title || instruction.slice(0, 40)}" (${child.id}) completed.\n\nFinal summary:\n${this.store.lastAssistantText(child.id) || '(no summary text)'}`
  }

  /** Abort every child of a parent. Called when the parent session is deleted;
   *  the settle handlers reconcile each child's status as its run unwinds. */
  dispose(parentSessionId: string): void {
    for (const child of this.store.childrenOf(parentSessionId)) {
      this.controllers.get(child.id)?.abort()
      this.store.setStatus(child.id, 'aborted')
    }
  }

  /** Abort every running child. Called when the backend shuts down. */
  stop(): void {
    for (const controller of this.controllers.values()) controller.abort()
    this.controllers.clear()
  }

  /** Children left marked running after a crash or quit can never finish:
   *  their turn is gone, so reconcile them to a terminal state. */
  reconcileStale(): void {
    for (const child of this.store.runningChildren()) {
      this.store.setStatus(child.id, 'error')
    }
  }
}