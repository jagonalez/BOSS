import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { GitHubDelivery } from '../shared/automation-trigger'
import type { BossEvent } from '../shared/notification'
import type { SupervisedThread } from '../shared/supervision'
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

function fixture(
  threads: SupervisedThread[] = [],
  refreshPullRequests?: LabAssistantHost['refreshPullRequests']
): {
  root: string
  manager: LabAssistantManager
  messages: Array<{ threadId: string; message: string }>
  notifications: BossEvent[]
} {
  const root = mkdtempSync(join(tmpdir(), 'boss-lab-assistant-manager-'))
  const messages: Array<{ threadId: string; message: string }> = []
  const notifications: BossEvent[] = []
  const host: LabAssistantHost = {
    threads: () => threads,
    messageAgent: async (threadId, message) => { messages.push({ threadId, message }) },
    ...(refreshPullRequests ? { refreshPullRequests } : {}),
    emit: () => {},
    notify: (event) => { notifications.push(event) }
  }
  return {
    root,
    manager: new LabAssistantManager(join(root, 'assistant.json'), host, () => 1_800_000_000_000),
    messages,
    notifications
  }
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
