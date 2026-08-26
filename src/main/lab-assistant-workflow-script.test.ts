import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LabAssistantWorkflowConfig } from '../shared/lab-assistant.ts'
import type { AgentOutcome, WorkflowRun } from '../shared/workflow.ts'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error Application code uses bundler resolution.
import { taskWorkflowBudget, taskWorkflowScript } from './lab-assistant-workflow-script.ts'
// @ts-expect-error Application code uses bundler resolution.
import { EventBus } from './event-bus.ts'
// @ts-expect-error Application code uses bundler resolution.
import { WorkflowStore } from './workflow-store.ts'
// @ts-expect-error Application code uses bundler resolution.
import { WorkflowEngine } from './workflow-engine.ts'
import type { WorkflowAgentRequest, WorkflowHost } from './workflow-engine.ts'

const CONFIG: LabAssistantWorkflowConfig = {
  planner: { backendId: 'claude', model: { providerID: 'anthropic', modelID: 'fable' }, instruction: 'Prefer small plans.' },
  implementer: { backendId: 'claude', model: { providerID: 'anthropic', modelID: 'opus' } },
  reviewers: [{ backendId: 'codex' }],
  maxReviewCycles: 2
}

class MockHost implements WorkflowHost {
  requests: { request: WorkflowAgentRequest; threadId: string }[] = []
  notices: { body: string; attention: boolean }[] = []
  private counter = 0
  private finished?: (threadId: string, outcome: AgentOutcome) => void
  async startAgent(request: WorkflowAgentRequest): Promise<{ threadId: string }> {
    this.counter += 1
    const threadId = `t-${this.counter}`
    this.requests.push({ request, threadId })
    return { threadId }
  }
  isAgentActive(): boolean {
    return false
  }
  async collectOutcome(): Promise<AgentOutcome | null> {
    return null
  }
  async abortAgent(): Promise<void> {}
  onAgentFinished(callback: (threadId: string, outcome: AgentOutcome) => void): void {
    this.finished = callback
  }
  notify(notice: { title: string; body: string; attention: boolean }): void {
    this.notices.push(notice)
  }
  finish(threadId: string, outcome: Partial<AgentOutcome>): void {
    this.finished?.(threadId, { status: 'success', changedFiles: 0, threadId, ...outcome })
  }
}

async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 1_500; i += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

test('the generated pipeline runs plan, implement, review cycles, and revision on the engine', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'boss-taskwf-'))
  const store = new WorkflowStore(join(dir, 'w.json'), join(dir, 'r.json'))
  const bus = new EventBus(join(dir, 's.json'), { now: () => 1 })
  const host = new MockHost()
  const engine = new WorkflowEngine(store, bus, host, { now: () => 1 })
  try {
    await engine.start()
    const workflow = await engine.create(
      {
        name: 'Task · Ship the widget',
        script: taskWorkflowScript({ title: 'Ship the widget', details: 'Small and safe.' }, CONFIG),
        projectPath: '/project',
        triggers: [],
        overlapPolicy: 'skip',
        budget: taskWorkflowBudget(CONFIG)
      },
      'builtin',
      { enabled: false }
    )
    const run = await engine.runNow(workflow.id)
    const runOf = (): WorkflowRun => store.runs.find((item: WorkflowRun) => item.id === run.id)!

    // Planner: project scope, plan mode, prompts carry the task and instruction.
    await until(() => host.requests.length === 1, 'planner')
    const planner = host.requests[0].request
    assert.match(planner.prompt, /Plan this task: Ship the widget/)
    assert.match(planner.prompt, /Prefer small plans/)
    assert.equal(planner.options.workspace, 'project')
    assert.equal(planner.options.backendId, 'claude')
    host.finish(host.requests[0].threadId, { text: 'The plan:\n1. Do the thing.' })

    // Implementer: fresh worktree, handoff embedded.
    await until(() => host.requests.length === 2, 'implementer')
    const implementer = host.requests[1].request
    assert.match(implementer.prompt, /Planner handoff:/)
    assert.match(implementer.prompt, /1\. Do the thing/)
    assert.equal(implementer.options.workspace, 'worktree')
    host.finish(host.requests[1].threadId, { summary: 'implemented', changedFiles: 3 })

    // Reviewer 1 requests changes: the revision runs in the implementer's checkout.
    await until(() => host.requests.length === 3, 'reviewer')
    const reviewer = host.requests[2].request
    assert.equal(reviewer.options.inWorktreeOf, host.requests[1].threadId)
    assert.equal(reviewer.options.backendId, 'codex')
    host.finish(host.requests[2].threadId, { text: 'CHANGES_REQUESTED\n- tighten the tests' })

    await until(() => host.requests.length === 4, 'revision')
    const revision = host.requests[3].request
    assert.match(revision.prompt, /tighten the tests/)
    assert.equal(revision.options.inWorktreeOf, host.requests[1].threadId)
    host.finish(host.requests[3].threadId, {})

    // Reviewer passes on cycle 2: the run completes.
    await until(() => host.requests.length === 5, 'second review')
    host.finish(host.requests[4].threadId, { text: 'All good.\nPASS' })
    await until(() => runOf().status === 'completed', 'completion')
    assert.match(String(runOf().result), /PASS in cycle 2/)
  } finally {
    engine.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test('exhausted review cycles fail the run with a pointed error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'boss-taskwf-'))
  const store = new WorkflowStore(join(dir, 'w.json'), join(dir, 'r.json'))
  const bus = new EventBus(join(dir, 's.json'), { now: () => 1 })
  const host = new MockHost()
  const engine = new WorkflowEngine(store, bus, host, { now: () => 1 })
  try {
    await engine.start()
    const workflow = await engine.create(
      {
        name: 'Task · Stubborn change',
        script: taskWorkflowScript({ title: 'Stubborn change' }, { ...CONFIG, maxReviewCycles: 1 }),
        projectPath: '/project',
        triggers: [],
        overlapPolicy: 'skip'
      },
      'builtin',
      { enabled: false }
    )
    const run = await engine.runNow(workflow.id)
    await until(() => host.requests.length === 1, 'planner')
    host.finish(host.requests[0].threadId, { text: 'plan' })
    await until(() => host.requests.length === 2, 'implementer')
    host.finish(host.requests[1].threadId, {})
    await until(() => host.requests.length === 3, 'reviewer')
    host.finish(host.requests[2].threadId, { text: 'CHANGES_REQUESTED\n- everything' })
    await until(() => store.runs.find((item: WorkflowRun) => item.id === run.id)!.status === 'failed', 'failure')
    assert.match(store.runs.find((item: WorkflowRun) => item.id === run.id)!.error ?? '', /still requests changes after 1 cycle/)
    assert.ok(host.notices.some((notice) => notice.attention))
  } finally {
    engine.stop()
    await rm(dir, { recursive: true, force: true })
  }
})
