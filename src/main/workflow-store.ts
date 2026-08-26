import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Workflow, WorkflowRun } from '../shared/workflow'
// @ts-expect-error Node's type-stripping test runner needs the extension.
import { WORKFLOW_DEFAULTS } from '../shared/workflow.ts'

interface WorkflowState {
  version: 1
  workflows: Workflow[]
  /** Per-workflow durable key/value memory, shared across runs. This is what
   *  lets a watcher remember e.g. a monitor's alert history between fires. */
  memory: Record<string, Record<string, unknown>>
}

interface RunState {
  version: 1
  runs: WorkflowRun[]
}

/** JSON persistence for workflows, runs, and per-workflow memory, following
 *  the userData file conventions used across BOSS managers. */
export class WorkflowStore {
  private loading?: Promise<void>
  workflows: Workflow[] = []
  runs: WorkflowRun[] = []
  private memory: Record<string, Record<string, unknown>> = {}
  private readonly stateFile: string
  private readonly runsFile: string

  // Explicit assignments: Node's strip-only TS loader (used by the unit
  // tests) cannot handle parameter properties.
  constructor(stateFile: string, runsFile: string) {
    this.stateFile = stateFile
    this.runsFile = runsFile
  }

  /** Memoized: concurrent first callers share one read, so a late file read
   *  can never clobber writes made by whoever got in after it. */
  load(): Promise<void> {
    this.loading ??= this.doLoad()
    return this.loading
  }

  private async doLoad(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.stateFile, 'utf8')) as Partial<WorkflowState>
      if (parsed.version === 1) {
        if (Array.isArray(parsed.workflows)) this.workflows = parsed.workflows
        if (parsed.memory && typeof parsed.memory === 'object') this.memory = parsed.memory
      }
    } catch {
      /* First launch starts with no workflows. */
    }
    try {
      const parsed = JSON.parse(await readFile(this.runsFile, 'utf8')) as Partial<RunState>
      if (parsed.version === 1 && Array.isArray(parsed.runs)) this.runs = parsed.runs
    } catch {
      /* First launch starts with no run history. */
    }
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.stateFile), { recursive: true })
    const state: WorkflowState = { version: 1, workflows: this.workflows, memory: this.memory }
    await writeFile(this.stateFile, JSON.stringify(state, null, 2))
    await writeFile(this.runsFile, JSON.stringify({ version: 1, runs: this.runs } satisfies RunState, null, 2))
  }

  workflow(id: string): Workflow {
    const found = this.workflows.find((item) => item.id === id)
    if (!found) throw new Error('Workflow not found.')
    return found
  }

  run(id: string): WorkflowRun {
    const found = this.runs.find((item) => item.id === id)
    if (!found) throw new Error('Workflow run not found.')
    return found
  }

  memoryGet(workflowId: string, key: string): unknown {
    return this.memory[workflowId]?.[key] ?? null
  }

  memorySet(workflowId: string, key: string, value: unknown): void {
    if (value === null || value === undefined) {
      if (this.memory[workflowId]) {
        delete this.memory[workflowId][key]
        if (Object.keys(this.memory[workflowId]).length === 0) delete this.memory[workflowId]
      }
      return
    }
    this.memory[workflowId] = this.memory[workflowId] ?? {}
    this.memory[workflowId][key] = value
  }

  /** Finished runs beyond the workflow's keepRuns cap, oldest first. The
   *  caller deletes their threads/worktrees before we forget them. */
  pruneCandidates(workflowId: string): WorkflowRun[] {
    const workflow = this.workflows.find((item) => item.id === workflowId)
    const keep = workflow?.keepRuns ?? WORKFLOW_DEFAULTS.keepRuns
    const finished = this.runs
      .filter((run) => run.workflowId === workflowId && run.status !== 'running' && run.status !== 'waiting')
      .sort((a, b) => b.startedAt - a.startedAt)
    return finished.slice(keep)
  }

  dropRuns(ids: Set<string>): void {
    this.runs = this.runs.filter((run) => !ids.has(run.id))
  }

  dropWorkflow(id: string): void {
    this.workflows = this.workflows.filter((item) => item.id !== id)
    this.runs = this.runs.filter((run) => run.workflowId !== id)
    delete this.memory[id]
  }
}
