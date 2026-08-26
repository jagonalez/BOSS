import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { GitHubDelivery } from '../shared/automation-trigger'
import type { BossEvent } from '../shared/notification'
import type { SupervisedThread } from '../shared/supervision'
import type { LabAssistantWorkflowConfig } from '../shared/lab-assistant'
import type { JournalEntry, WorkflowRun } from '../shared/workflow'
// @ts-expect-error Node's type-stripping test runner needs the extension.
import { LabAssistantManager, type LabAssistantHost } from './lab-assistant-manager.ts'

function prDelivery(number: number, overrides: Record<string, unknown> = {}): GitHubDelivery {
  return {
    event: 'pull_request',
    action: 'opened',
    body: {
      action: 'opened',
      number,
      repository: { full_name: 'jagonalez/BOSS' },
      pull_request: {
        title: `PR ${number}`,
        html_url: `https://github.com/jagonalez/BOSS/pull/${number}`,
        head: { ref: `feature-${number}` },
        base: { ref: 'main' },
        mergeable: true,
        mergeable_state: 'clean'
      },
      ...overrides
    }
  }
}

function workflowDelivery(
  conclusion: 'failure' | 'success',
  overrides: Record<string, unknown> = {}
): GitHubDelivery {
  return {
    event: 'workflow_run',
    action: 'completed',
    body: {
      action: 'completed',
      repository: { full_name: 'jagonalez/BOSS' },
      workflow_run: {
        id: 801,
        workflow_id: 42,
        run_number: 19,
        run_attempt: 1,
        name: 'CI',
        html_url: 'https://github.com/jagonalez/BOSS/actions/runs/801',
        head_branch: 'feature-ci',
        head_sha: 'abc123',
        status: 'completed',
        conclusion,
        pull_requests: [{ number: 31 }],
        ...overrides
      }
    }
  }
}

function thread(branch: string, id = 'agent-codex'): SupervisedThread {
  return {
    threadId: id,
    backendId: 'codex',
    title: 'Codex implementation',
    projectPath: '/tmp/BOSS',
    executionPath: `/tmp/BOSS/${branch}`,
    updatedAt: 1,
    worktreeBranch: branch,
    running: false,
    usage: { runs: 0, durationMs: 0, tokenRuns: 0, toolCalls: 0 }
  }
}

interface StartedTaskWorkflow {
  workflowId?: string
  name: string
  projectPath: string
  script: string
  budget?: { maxAgentRuns?: number }
}

function fixture(
  threads: SupervisedThread[] = [],
  refreshPullRequests?: LabAssistantHost['refreshPullRequests'],
  inspectWorkflowRun?: LabAssistantHost['inspectWorkflowRun']
): {
  root: string
  manager: LabAssistantManager
  messages: Array<{ threadId: string; message: string }>
  notifications: BossEvent[]
  starts: StartedTaskWorkflow[]
} {
  const root = mkdtempSync(join(tmpdir(), 'boss-lab-assistant-manager-'))
  const messages: Array<{ threadId: string; message: string }> = []
  const notifications: BossEvent[] = []
  const starts: StartedTaskWorkflow[] = []
  const host: LabAssistantHost = {
    threads: () => threads,
    messageAgent: async (threadId, message) => { messages.push({ threadId, message }) },
    ...(refreshPullRequests ? { refreshPullRequests } : {}),
    ...(inspectWorkflowRun ? { inspectWorkflowRun } : {}),
    startTaskWorkflow: async (input) => {
      starts.push(input)
      return { workflowId: input.workflowId ?? `wf-${starts.length}`, runId: `run-${starts.length}` }
    },
    emit: () => {},
    notify: (event) => { notifications.push(event) }
  }
  return {
    root,
    manager: new LabAssistantManager(join(root, 'assistant.json'), host, () => 1_800_000_000_000),
    messages,
    notifications,
    starts
  }
}

function engineRun(workflowId: string, patch: Partial<WorkflowRun>): WorkflowRun {
  return {
    id: 'run-1',
    workflowId,
    trigger: 'manual',
    status: 'running',
    journal: [],
    usage: { agentRuns: 0, judgeCalls: 0, notifies: 0 },
    startedAt: 1,
    ...patch
  }
}

function workflowsUpdated(...runs: WorkflowRun[]): Record<string, unknown> {
  return { type: 'workflows.updated', properties: { snapshot: { workflows: [], runs } } }
}

function agentStep(seq: number, threadId: string): JournalEntry {
  return { seq, op: 'agent', argsHash: 'x', status: 'done', threadId, startedAt: 1, finishedAt: 2 }
}

const managedWorkflow: LabAssistantWorkflowConfig = {
  planner: { backendId: 'claude' },
  implementer: { backendId: 'codex' },
  reviewers: [{ backendId: 'lab' }],
  maxReviewCycles: 2
}

test('two clean PRs create one durable merge-order question and persist the answer', async () => {
  const { root, manager, notifications } = fixture()
  try {
    await manager.observeGitHub(prDelivery(21))
    await manager.observeGitHub(prDelivery(22))
    await manager.observeGitHub(prDelivery(22))
    const pending = await manager.snapshot()
    assert.equal(pending.questions.length, 1)
    assert.equal(pending.questions[0].status, 'open')
    assert.deepEqual(pending.questions[0].options.map((option) => option.id), [
      'jagonalez/BOSS#21',
      'jagonalez/BOSS#22'
    ])
    assert.equal(notifications.length, 1)

    const answered = await manager.answer(pending.questions[0].id, 'jagonalez/BOSS#22')
    assert.equal(answered.questions[0].status, 'answered')
    assert.deepEqual(answered.mergeOrders['jagonalez/BOSS:main'], [
      'jagonalez/BOSS#22',
      'jagonalez/BOSS#21'
    ])

    const restored = new LabAssistantManager(join(root, 'assistant.json'), {
      threads: () => [], messageAgent: async () => {}, emit: () => {}, notify: () => {}
    })
    assert.equal((await restored.snapshot()).questions[0].answerId, 'jagonalez/BOSS#22')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a conflicted PR is routed once to the matching worktree owner', async () => {
  const { root, manager, messages } = fixture([thread('feature-22')])
  const conflicted = prDelivery(22, {
    pull_request: {
      title: 'Dependent change',
      html_url: 'https://github.com/jagonalez/BOSS/pull/22',
      head: { ref: 'feature-22' },
      base: { ref: 'main' },
      mergeable: false,
      mergeable_state: 'dirty'
    }
  })
  try {
    await manager.observeGitHub(conflicted)
    await manager.observeGitHub(conflicted)
    assert.equal(messages.length, 1)
    assert.equal(messages[0].threadId, 'agent-codex')
    assert.match(messages[0].message, /conflict/i)
    assert.equal((await manager.snapshot()).pullRequests[0].conflictRoutedTo, 'agent-codex')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('starting a managed task hands a generated pipeline to the workflow engine', async () => {
  const { root, manager, starts, notifications } = fixture()
  try {
    let snapshot = await manager.createTask({ title: 'Build managed workflow', projectPath: '/tmp/BOSS' })
    const taskId = snapshot.tasks[0].id
    await manager.configureWorkflow(managedWorkflow)
    snapshot = await manager.startWorkflow(taskId)
    assert.equal(snapshot.tasks[0].status, 'running')
    assert.equal(snapshot.tasks[0].workflowId, 'wf-1')
    assert.equal(starts.length, 1)
    assert.equal(starts[0].name, 'Task · Build managed workflow')
    assert.equal(starts[0].projectPath, '/tmp/BOSS')
    // The script carries the whole pipeline: prompts, role agents, verdict contract.
    assert.match(starts[0].script, /Plan this task: Build managed workflow/)
    assert.match(starts[0].script, /exactly PASS or CHANGES_REQUESTED/)
    assert.match(starts[0].script, /"backendId":"codex"/)
    assert.ok((starts[0].budget?.maxAgentRuns ?? 0) >= 2 + 2 * managedWorkflow.maxReviewCycles)

    // Engine progress assigns the freshest step thread to the task.
    await manager.observeBackendEvent(workflowsUpdated(engineRun('wf-1', {
      journal: [agentStep(0, 'planner-thread'), agentStep(1, 'implementer-thread')]
    })))
    snapshot = await manager.snapshot()
    assert.equal(snapshot.tasks[0].assignedThreadId, 'implementer-thread')

    // A completed run completes the task and notifies.
    await manager.observeBackendEvent(workflowsUpdated(engineRun('wf-1', {
      status: 'completed',
      result: 'PASS in cycle 1',
      journal: [agentStep(0, 'planner-thread'), agentStep(1, 'implementer-thread')]
    })))
    snapshot = await manager.snapshot()
    assert.equal(snapshot.tasks[0].status, 'done')
    assert.ok(notifications.some((event) => event.type === 'task.completed'))

    const restored = new LabAssistantManager(join(root, 'assistant.json'), {
      threads: () => [], messageAgent: async () => {}, emit: () => {}, notify: () => {}
    })
    const durable = await restored.snapshot()
    assert.equal(durable.workflowConfig?.implementer.backendId, 'codex')
    assert.equal(durable.tasks[0].status, 'done')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a failed engine run raises one question; answering stop returns the task to ready', async () => {
  const { root, manager, starts, notifications } = fixture()
  try {
    const created = await manager.createTask({ title: 'Bounded review', projectPath: '/tmp/BOSS' })
    await manager.configureWorkflow({ ...managedWorkflow, maxReviewCycles: 1 })
    await manager.startWorkflow(created.tasks[0].id)

    const failed = engineRun('wf-1', { status: 'failed', error: 'Review still requests changes after 1 cycle.' })
    await manager.observeBackendEvent(workflowsUpdated(failed))
    // The same snapshot arriving again must not duplicate the question.
    await manager.observeBackendEvent(workflowsUpdated(failed))

    let snapshot = await manager.snapshot()
    const question = snapshot.questions.find((item) => item.key.startsWith('task-workflow:'))
    assert.ok(question)
    assert.equal(question!.status, 'open')
    assert.match(question!.prompt, /still requests changes/i)
    assert.equal(snapshot.questions.filter((item) => item.key.startsWith('task-workflow:')).length, 1)
    assert.ok(notifications.some((event) => event.type === 'task.needs_attention'))

    snapshot = await manager.answer(question!.id, 'stop')
    assert.equal(snapshot.tasks[0].status, 'ready')
    assert.equal(snapshot.tasks[0].assignedThreadId, undefined)

    // Restarting reuses the task's workflow rather than minting a new one.
    await manager.startWorkflow(created.tasks[0].id)
    assert.equal(starts.length, 2)
    assert.equal(starts[1].workflowId, 'wf-1')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a conflict without one clear owner asks the user instead of guessing', async () => {
  const { root, manager, messages } = fixture()
  try {
    await manager.observeGitHub(prDelivery(23, {
      pull_request: {
        title: 'Unowned change',
        head: { ref: 'unknown-owner' },
        base: { ref: 'main' },
        mergeable: false,
        mergeable_state: 'dirty'
      }
    }))
    const snapshot = await manager.snapshot()
    assert.equal(messages.length, 0)
    assert.equal(snapshot.questions.length, 1)
    assert.match(snapshot.questions[0].prompt, /no owning agent/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a merged PR refreshes its siblings and routes a newly exposed conflict', async () => {
  const refreshedPr = {
    id: 'jagonalez/BOSS#22',
    repository: 'jagonalez/BOSS',
    number: 22,
    title: 'Dependent change',
    url: 'https://github.com/jagonalez/BOSS/pull/22',
    headBranch: 'feature-22',
    baseBranch: 'main',
    state: 'open' as const,
    mergeability: 'conflicted' as const,
    updatedAt: 2
  }
  const { root, manager, messages } = fixture([thread('feature-22')], async () => [refreshedPr])
  const merged = prDelivery(21, {
    action: 'closed',
    pull_request: {
      title: 'Base change',
      html_url: 'https://github.com/jagonalez/BOSS/pull/21',
      head: { ref: 'feature-21' },
      base: { ref: 'main' },
      merged: true,
      mergeable: true,
      mergeable_state: 'clean'
    }
  })
  merged.action = 'closed'
  try {
    await manager.observeGitHub(merged)
    assert.equal(messages.length, 1)
    assert.equal(messages[0].threadId, 'agent-codex')
    assert.match(messages[0].message, /PR #22/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an open PR event refreshes unknown webhook mergeability before deciding', async () => {
  const refreshedPr = {
    id: 'jagonalez/BOSS#24',
    repository: 'jagonalez/BOSS',
    number: 24,
    title: 'Needs a rebase',
    url: 'https://github.com/jagonalez/BOSS/pull/24',
    headBranch: 'feature-24',
    baseBranch: 'main',
    state: 'open' as const,
    mergeability: 'conflicted' as const,
    updatedAt: 2
  }
  let refreshes = 0
  const { root, manager, messages } = fixture([thread('feature-24')], async () => {
    refreshes += 1
    return [refreshedPr]
  })
  const unknown = prDelivery(24, {
    pull_request: {
      title: 'Needs a rebase',
      html_url: 'https://github.com/jagonalez/BOSS/pull/24',
      head: { ref: 'feature-24' },
      base: { ref: 'main' },
      mergeable: null,
      mergeable_state: 'unknown'
    }
  })
  try {
    await manager.observeGitHub(unknown)
    assert.equal(refreshes, 1)
    assert.equal(messages.length, 1)
    assert.equal(messages[0].threadId, 'agent-codex')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an authoritative clean refresh overrides a stale conflicted webhook', async () => {
  const refreshedPr = {
    id: 'jagonalez/BOSS#25',
    repository: 'jagonalez/BOSS',
    number: 25,
    title: 'Already rebased',
    url: 'https://github.com/jagonalez/BOSS/pull/25',
    headBranch: 'feature-25',
    baseBranch: 'main',
    state: 'open' as const,
    mergeability: 'clean' as const,
    updatedAt: 2
  }
  const { root, manager, messages } = fixture([thread('feature-25')], async () => [refreshedPr])
  try {
    await manager.observeGitHub(prDelivery(25, {
      pull_request: {
        title: 'Already rebased',
        head: { ref: 'feature-25' },
        base: { ref: 'main' },
        mergeable: false,
        mergeable_state: 'dirty'
      }
    }))
    assert.equal(messages.length, 0)
    assert.equal((await manager.snapshot()).pullRequests[0].mergeability, 'clean')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('simultaneous webhook deliveries serialize their refresh and persistence work', async () => {
  let activeRefreshes = 0
  let maxActiveRefreshes = 0
  const { root, manager } = fixture([], async () => {
    activeRefreshes += 1
    maxActiveRefreshes = Math.max(maxActiveRefreshes, activeRefreshes)
    await new Promise<void>((resolve) => setImmediate(resolve))
    activeRefreshes -= 1
    return []
  })
  try {
    await Promise.all([
      manager.observeGitHub(prDelivery(26)),
      manager.observeGitHub(prDelivery(27))
    ])
    assert.equal(maxActiveRefreshes, 1)
    assert.deepEqual((await manager.snapshot()).pullRequests.map((pullRequest) => pullRequest.number), [26, 27])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a failed workflow run is enriched and routed once to its branch owner', async () => {
  let inspections = 0
  const { root, manager, messages, notifications } = fixture(
    [thread('feature-ci')],
    undefined,
    async (_repository, runId, attempt) => {
      inspections += 1
      assert.equal(runId, 801)
      assert.equal(attempt, 1)
      return [{
        name: 'Electron end-to-end',
        url: 'https://github.com/jagonalez/BOSS/actions/runs/801/job/9',
        conclusion: 'failure',
        failedSteps: ['Run npm run test:e2e']
      }]
    }
  )
  try {
    await manager.observeGitHub(workflowDelivery('failure'))
    await manager.observeGitHub(workflowDelivery('failure'))

    assert.equal(inspections, 1)
    assert.equal(messages.length, 1)
    assert.equal(messages[0].threadId, 'agent-codex')
    assert.match(messages[0].message, /Electron end-to-end/)
    assert.match(messages[0].message, /Run npm run test:e2e/)
    assert.match(messages[0].message, /investigate the root cause/i)
    assert.deepEqual(notifications.map((event) => event.type), ['task.failed'])

    const snapshot = await manager.snapshot()
    assert.equal(snapshot.ciIncidents.length, 1)
    assert.equal(snapshot.ciIncidents[0].status, 'failing')
    assert.equal(snapshot.ciIncidents[0].occurrenceCount, 1)
    assert.equal(snapshot.ciIncidents[0].routedTo, 'agent-codex')

    const restored = new LabAssistantManager(join(root, 'assistant.json'), {
      threads: () => [], messageAgent: async () => {}, emit: () => {}, notify: () => {}
    })
    assert.equal((await restored.snapshot()).ciIncidents[0].lastDeliveryKey, '801:1:failure')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a failed rerun is a new occurrence while a passing rerun resolves the episode', async () => {
  const { root, manager, messages } = fixture(
    [thread('feature-ci')],
    undefined,
    async () => [{ name: 'check', url: '', conclusion: 'failure', failedSteps: ['npm test'] }]
  )
  try {
    await manager.observeGitHub(workflowDelivery('failure'))
    const repeated = await manager.observeGitHub(workflowDelivery('failure', { run_attempt: 2 }))
    assert.equal(repeated.ciIncidents[0].occurrenceCount, 2)
    assert.equal(messages.length, 2)
    assert.match(messages[1].message, /attempt 2/)

    const resolved = await manager.observeGitHub(workflowDelivery('success', { run_attempt: 3 }))
    assert.equal(resolved.ciIncidents[0].status, 'resolved')
    assert.equal(resolved.ciIncidents[0].resolvedAt, 1_800_000_000_000)
    assert.match(resolved.activities[0].title, /recovered/)
    assert.equal(messages.length, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an unowned workflow failure asks the user and routes their answer with run-level fallback', async () => {
  const { root, manager, messages } = fixture(
    [thread('another-branch', 'agent-review')],
    undefined,
    async () => []
  )
  try {
    const pending = await manager.observeGitHub(workflowDelivery('failure'))
    assert.equal(messages.length, 0)
    const question = pending.questions.find((item) => item.key.startsWith('ci-owner:'))
    assert.ok(question)
    assert.match(question.prompt, /CI failed/)
    assert.deepEqual(question.options, [{ id: 'agent-review', label: 'Codex implementation' }])

    const answered = await manager.answer(question.id, 'agent-review')
    assert.equal(messages.length, 1)
    assert.match(messages[0].message, /did not report a failed job or step/i)
    assert.match(messages[0].message, /actions\/runs\/801/)
    assert.equal(answered.ciIncidents[0].routedTo, 'agent-review')
    assert.equal(answered.questions.find((item) => item.id === question.id)?.status, 'answered')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a recovered workflow dismisses an unanswered routing decision', async () => {
  const { root, manager } = fixture([], undefined, async () => [])
  try {
    const failed = await manager.observeGitHub(workflowDelivery('failure'))
    assert.equal(failed.questions.find((item) => item.key.startsWith('ci-owner:'))?.status, 'open')
    const resolved = await manager.observeGitHub(workflowDelivery('success', { run_attempt: 2 }))
    assert.equal(resolved.questions.find((item) => item.key.startsWith('ci-owner:'))?.status, 'dismissed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a failed rerun replaces its prior unanswered routing decision', async () => {
  const { root, manager } = fixture([], undefined, async () => [])
  try {
    const first = await manager.observeGitHub(workflowDelivery('failure'))
    const firstQuestion = first.questions.find((item) => item.key.startsWith('ci-owner:'))!
    const rerun = await manager.observeGitHub(workflowDelivery('failure', { run_attempt: 2 }))
    assert.equal(rerun.questions.find((item) => item.id === firstQuestion.id)?.status, 'dismissed')
    assert.equal(rerun.questions.filter((item) => item.status === 'open' && item.key.startsWith('ci-owner:')).length, 1)
    assert.match(rerun.questions.find((item) => item.status === 'open')?.key ?? '', /801:2:failure$/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an older successful delivery cannot resolve a newer workflow failure', async () => {
  const { root, manager } = fixture([], undefined, async () => [])
  try {
    await manager.observeGitHub(workflowDelivery('failure', { id: 802, run_number: 20 }))
    const stale = await manager.observeGitHub(workflowDelivery('success', { id: 801, run_number: 19 }))
    assert.equal(stale.ciIncidents[0].status, 'failing')
    assert.equal(stale.ciIncidents[0].runNumber, 20)
    assert.equal(stale.questions.filter((item) => item.status === 'open' && item.key.startsWith('ci-owner:')).length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ready tasks create a durable ordered-or-parallel decision', async () => {
  const { root, manager } = fixture()
  try {
    const first = (await manager.createTask({ title: 'Plan the change', projectPath: '/tmp/BOSS' })).tasks[0]
    const pending = await manager.createTask({ title: 'Prototype the UI', projectPath: '/tmp/BOSS' })
    const question = pending.questions.find((item) => item.key.startsWith('task-order:'))
    assert.ok(question)
    assert.deepEqual(question.options.map((option) => option.label), [
      'Plan the change',
      'Prototype the UI',
      'Run in parallel'
    ])

    const answered = await manager.answer(question.id, 'parallel')
    assert.equal(answered.taskPlans['/tmp/BOSS'].mode, 'parallel')
    assert.equal(answered.taskPlans['/tmp/BOSS'].taskIds.includes(first.id), true)

    const restored = new LabAssistantManager(join(root, 'assistant.json'), {
      threads: () => [], messageAgent: async () => {}, emit: () => {}, notify: () => {}
    })
    assert.equal((await restored.snapshot()).taskPlans['/tmp/BOSS'].mode, 'parallel')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an ordered task plan blocks successors until the selected first task completes', async () => {
  const { root, manager } = fixture()
  try {
    const first = (await manager.createTask({ title: 'First task' })).tasks[0]
    const pending = await manager.createTask({ title: 'Second task' })
    const second = pending.tasks.find((task) => task.title === 'Second task')!
    const question = pending.questions.find((item) => item.key.startsWith('task-order:'))!

    const ordered = await manager.answer(question.id, first.id)
    assert.equal(ordered.tasks.find((task) => task.id === first.id)?.status, 'ready')
    assert.equal(ordered.tasks.find((task) => task.id === second.id)?.status, 'blocked')

    const advanced = await manager.updateTask(first.id, { status: 'done' })
    assert.equal(advanced.tasks.find((task) => task.id === second.id)?.status, 'ready')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('completing a dependency moves blocked work to ready', async () => {
  const { root, manager } = fixture()
  try {
    const prerequisite = (await manager.createTask({ title: 'Build the foundation' })).tasks[0]
    const blocked = await manager.createTask({ title: 'Ship the workflow', dependsOn: [prerequisite.id] })
    assert.equal(blocked.tasks.find((task) => task.title === 'Ship the workflow')?.status, 'blocked')

    const advanced = await manager.updateTask(prerequisite.id, { status: 'done' })
    assert.equal(advanced.tasks.find((task) => task.title === 'Ship the workflow')?.status, 'ready')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a task state change dismisses an ordering question that is no longer current', async () => {
  const { root, manager } = fixture()
  try {
    const first = (await manager.createTask({ title: 'Keep' })).tasks[0]
    const pending = await manager.createTask({ title: 'Finish directly' })
    const second = pending.tasks.find((task) => task.id !== first.id)!
    const question = pending.questions.find((item) => item.key.startsWith('task-order:'))!

    const updated = await manager.updateTask(second.id, { status: 'done' })
    assert.equal(updated.questions.find((item) => item.id === question.id)?.status, 'dismissed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('task dependencies reject cycles instead of creating permanently blocked work', async () => {
  const { root, manager } = fixture()
  try {
    const first = (await manager.createTask({ title: 'First' })).tasks[0]
    const second = (await manager.createTask({ title: 'Second', dependsOn: [first.id] })).tasks.find((task) => task.title === 'Second')!
    await assert.rejects(() => manager.updateTask(first.id, { dependsOn: [second.id] }), /cycle/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('explicit assignment hands a ready project task to the selected agent', async () => {
  const { root, manager, messages } = fixture([thread('feature-task')])
  try {
    const task = (await manager.createTask({
      title: 'Implement the task graph',
      details: 'Keep the control plane deterministic.',
      projectPath: '/tmp/BOSS'
    })).tasks[0]
    const assigned = await manager.assignTask(task.id, 'agent-codex')
    assert.equal(assigned.tasks[0].status, 'running')
    assert.equal(assigned.tasks[0].assignedThreadId, 'agent-codex')
    assert.equal(messages.length, 1)
    assert.match(messages[0].message, /Implement the task graph/)
    assert.match(messages[0].message, /deterministic/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
