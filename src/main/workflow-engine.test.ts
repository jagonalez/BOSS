import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentOutcome, WorkflowInput, WorkflowRun } from '../shared/workflow.ts'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error Application code uses bundler resolution.
import { EventBus } from './event-bus.ts'
// @ts-expect-error Application code uses bundler resolution.
import { WorkflowStore } from './workflow-store.ts'
// @ts-expect-error Application code uses bundler resolution.
import { WorkflowEngine } from './workflow-engine.ts'
import type { WorkflowAgentRequest, WorkflowHost } from './workflow-engine.ts'

class MockHost implements WorkflowHost {
  requests: { request: WorkflowAgentRequest; threadId: string }[] = []
  notices: { title: string; body: string; attention: boolean }[] = []
  aborted: string[] = []
  active = new Set<string>()
  collectable = new Map<string, AgentOutcome>()
  private counter = 0
  private finished?: (threadId: string, outcome: AgentOutcome) => void
  private readonly prefix: string

  constructor(prefix = 'thread') {
    this.prefix = prefix
  }

  async startAgent(request: WorkflowAgentRequest): Promise<{ threadId: string }> {
    this.counter += 1
    const threadId = `${this.prefix}-${this.counter}`
    this.requests.push({ request, threadId })
    this.active.add(threadId)
    return { threadId }
  }

  isAgentActive(threadId: string): boolean {
    return this.active.has(threadId)
  }

  async collectOutcome(threadId: string): Promise<AgentOutcome | null> {
    return this.collectable.get(threadId) ?? null
  }

  async abortAgent(threadId: string): Promise<void> {
    this.active.delete(threadId)
    this.aborted.push(threadId)
  }

  onAgentFinished(callback: (threadId: string, outcome: AgentOutcome) => void): void {
    this.finished = callback
  }

  notify(notice: { title: string; body: string; attention: boolean }): void {
    this.notices.push(notice)
  }

  delivered: { threadId: string; body: string }[] = []

  async deliverToThread(threadId: string, body: string): Promise<void> {
    this.delivered.push({ threadId, body })
  }

  finish(threadId: string, outcome: Partial<AgentOutcome>): void {
    this.active.delete(threadId)
    this.finished?.(threadId, { status: 'success', changedFiles: 0, threadId, ...outcome })
  }
}

interface Rig {
  dir: string
  store: WorkflowStore
  bus: EventBus
  host: MockHost
  engine: WorkflowEngine
  drainSaves: () => Promise<void>
  setNow: (value: number) => void
}

let now = 1_000_000

async function rig(dir?: string, prefix = 'thread', beforeStart?: (host: MockHost) => void): Promise<Rig> {
  const base = dir ?? (await mkdtemp(join(tmpdir(), 'boss-workflows-')))
  const store = new WorkflowStore(join(base, 'workflows.json'), join(base, 'workflow-runs.json'))
  const save = store.save.bind(store)
  const pendingSaves = new Set<Promise<void>>()
  store.save = async () => {
    const pending = save()
    pendingSaves.add(pending)
    try {
      await pending
    } finally {
      pendingSaves.delete(pending)
    }
  }
  const bus = new EventBus(join(base, 'subscriptions.json'), { now: () => now })
  const host = new MockHost(prefix)
  const engine = new WorkflowEngine(store, bus, host, { now: () => now })
  beforeStart?.(host)
  await engine.start()
  return {
    dir: base,
    store,
    bus,
    host,
    engine,
    drainSaves: async () => {
      while (pendingSaves.size > 0) await Promise.allSettled([...pendingSaves])
    },
    setNow: (value) => (now = value)
  }
}

async function stop(rigged: Rig): Promise<void> {
  rigged.engine.stop()
  await rigged.drainSaves()
}

async function drop(rigged: Rig): Promise<void> {
  // rm({ force: true }) succeeds while a save is between its two file writes;
  // removing the directory then made that save reject after the test ended.
  // Stop future persistence and drain writes already in flight before cleanup.
  await stop(rigged)
  await rm(rigged.dir, { recursive: true, force: true })
}

async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let i = 0; i < 1_500; i += 1) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

/** The run as last persisted to disk — what a restarted engine would see. */
async function persistedRun(dir: string, runId: string): Promise<WorkflowRun | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, 'workflow-runs.json'), 'utf8')) as { runs?: WorkflowRun[] }
    return parsed.runs?.find((item) => item.id === runId)
  } catch {
    return undefined
  }
}

function definition(script: string, patch?: Partial<WorkflowInput>): WorkflowInput {
  return {
    name: 'Test workflow',
    script,
    projectPath: '/project',
    triggers: [],
    overlapPolicy: 'skip',
    ...patch
  }
}

function runOf(rigged: Rig, runId: string): WorkflowRun {
  const found = rigged.store.runs.find((item: WorkflowRun) => item.id === runId)
  assert.ok(found, 'run exists')
  return found!
}

test('a simple script journals its steps and completes with a result', async () => {
  const rigged = await rig()
  try {
    const workflow = await rigged.engine.create(definition(`log('starting'); return 42`))
    const run = await rigged.engine.runNow(workflow.id)
    await until(() => runOf(rigged, run.id).status === 'completed', 'completion')
    const done = runOf(rigged, run.id)
    assert.equal(done.result, 42)
    assert.equal(done.journal.length, 1)
    assert.equal(done.journal[0].op, 'log')
    assert.equal(done.journal[0].status, 'done')
  } finally {
    await drop(rigged)
  }
})

test('nondeterminism guards fail the run with a pointed message', async () => {
  const rigged = await rig()
  try {
    const workflow = await rigged.engine.create(definition(`return Date.now()`))
    const run = await rigged.engine.runNow(workflow.id)
    await until(() => runOf(rigged, run.id).status === 'failed', 'failure')
    assert.match(runOf(rigged, run.id).error ?? '', /nondeterministic/)

    const random = await rigged.engine.create(definition(`return Math.random()`, { name: 'Random' }))
    const randomRun = await rigged.engine.runNow(random.id)
    await until(() => runOf(rigged, randomRun.id).status === 'failed', 'failure')
    assert.match(runOf(rigged, randomRun.id).error ?? '', /nondeterministic/)
  } finally {
    await drop(rigged)
  }
})

test('a script that does not parse is rejected at create time', async () => {
  const rigged = await rig()
  try {
    await assert.rejects(() => rigged.engine.create(definition('return ((')), /does not parse/)
  } finally {
    await drop(rigged)
  }
})

test('agent steps run through the host and resolve with the outcome', async () => {
  const rigged = await rig()
  try {
    const workflow = await rigged.engine.create(definition(`const r = await agent('fix the bug'); return r.summary`))
    const run = await rigged.engine.runNow(workflow.id)
    await until(() => rigged.host.requests.length === 1, 'agent start')
    const { request, threadId } = rigged.host.requests[0]
    assert.match(request.prompt, /fix the bug/)
    assert.match(request.prompt, /BOSS WORKFLOW STEP/)
    assert.equal(request.projectPath, '/project')
    assert.equal(runOf(rigged, run.id).status, 'running')

    rigged.host.finish(threadId, { summary: 'fixed it' })
    await until(() => runOf(rigged, run.id).status === 'completed', 'completion')
    assert.equal(runOf(rigged, run.id).result, 'fixed it')
    assert.equal(runOf(rigged, run.id).usage.agentRuns, 1)
  } finally {
    await drop(rigged)
  }
})

test('parallel agent calls keep deterministic step order', async () => {
  const rigged = await rig()
  try {
    const workflow = await rigged.engine.create(
      definition(`const [a, b] = await Promise.all([agent('first'), agent('second')]); return a.summary + '+' + b.summary`)
    )
    const run = await rigged.engine.runNow(workflow.id)
    await until(() => rigged.host.requests.length === 2, 'both agents started')
    // Finish them in reverse order; the script still gets each one's own result.
    rigged.host.finish(rigged.host.requests[1].threadId, { summary: 'B' })
    rigged.host.finish(rigged.host.requests[0].threadId, { summary: 'A' })
    await until(() => runOf(rigged, run.id).status === 'completed', 'completion')
    assert.equal(runOf(rigged, run.id).result, 'A+B')
  } finally {
    await drop(rigged)
  }
})

test('waitFor parks the run and an event resumes it', async () => {
  const rigged = await rig()
  try {
    const workflow = await rigged.engine.create(
      definition(`const ev = await waitFor({ type: 'ci.completed', filters: { branch: 'main' } }); return ev.data.conclusion`)
    )
    const run = await rigged.engine.runNow(workflow.id)
    await until(() => runOf(rigged, run.id).status === 'waiting', 'waiting')

    await rigged.bus.publish({ id: 'x', type: 'ci.completed', at: now, data: { branch: 'other', conclusion: 'failure' } })
    assert.equal(runOf(rigged, run.id).status, 'waiting')

    await rigged.bus.publish({ id: 'y', type: 'ci.completed', at: now, data: { branch: 'main', conclusion: 'success' } })
    await until(() => runOf(rigged, run.id).status === 'completed', 'completion')
    assert.equal(runOf(rigged, run.id).result, 'success')
  } finally {
    await drop(rigged)
  }
})

test('waitFor timeouts resolve with null', async () => {
  const rigged = await rig()
  try {
    const workflow = await rigged.engine.create(
      definition(`const ev = await waitFor({ type: 'never.happens' }, { timeoutMs: 60000 }); return ev === null ? 'timed out' : 'event'`)
    )
    const run = await rigged.engine.runNow(workflow.id)
    await until(() => runOf(rigged, run.id).status === 'waiting', 'waiting')
    rigged.setNow(now + 120_000)
    await rigged.bus.tick()
    await until(() => runOf(rigged, run.id).status === 'completed', 'completion')
    assert.equal(runOf(rigged, run.id).result, 'timed out')
  } finally {
    await drop(rigged)
  }
})

test('a run parked on waitFor survives an app restart', async () => {
  const first = await rig()
  const dir = first.dir
  let runId = ''
  try {
    const workflow = await first.engine.create(
      definition(`log('before'); const ev = await waitFor({ type: 'pr.review' }); notify('review arrived'); return ev.data.author`)
    )
    const run = await first.engine.runNow(workflow.id)
    runId = run.id
    await until(async () => (await persistedRun(dir, run.id))?.status === 'waiting', 'persisted waiting state')
    await stop(first)
  } catch (error) {
    await drop(first)
    throw error
  }

  // A fresh engine over the same files: the journal replays, the durable
  // subscription still matches, and the event finishes the run.
  const second = await rig(dir, 'reborn')
  try {
    await until(() => second.store.runs.some((item: WorkflowRun) => item.id === runId), 'run loaded')
    await second.bus.publish({ id: 'z', type: 'pr.review', at: now, data: { author: 'coderabbit' } })
    await until(() => runOf(second, runId).status === 'completed', 'completion after restart')
    const done = runOf(second, runId)
    assert.equal(done.result, 'coderabbit')
    // The pre-restart notify was journaled once and must not repeat.
    assert.equal(second.host.notices.filter((notice) => notice.body === 'review arrived').length, 1)
    assert.equal(done.journal.filter((entry) => entry.op === 'log').length, 1)
  } finally {
    await drop(second)
  }
})

test('an agent step whose thread vanished over a restart re-performs in a fresh thread', async () => {
  const first = await rig()
  const dir = first.dir
  let runId = ''
  try {
    const workflow = await first.engine.create(definition(`const r = await agent('long task'); return r.summary`))
    const run = await first.engine.runNow(workflow.id)
    runId = run.id
    await until(async () => Boolean((await persistedRun(dir, run.id))?.journal[0]?.threadId), 'persisted agent step')
    await stop(first)
  } catch (error) {
    await drop(first)
    throw error
  }

  const second = await rig(dir, 'reborn')
  try {
    await until(() => second.host.requests.length === 1, 'agent restarted')
    assert.match(second.host.requests[0].request.prompt, /long task/)
    second.host.finish(second.host.requests[0].threadId, { summary: 'done after restart' })
    await until(() => runOf(second, runId).status === 'completed', 'completion')
    assert.equal(runOf(second, runId).result, 'done after restart')
  } finally {
    await drop(second)
  }
})

test('an agent outcome that arrived while the app was down is collected, not re-run', async () => {
  const first = await rig()
  const dir = first.dir
  let runId = ''
  let threadId = ''
  try {
    const workflow = await first.engine.create(definition(`const r = await agent('long task'); return r.summary`))
    const run = await first.engine.runNow(workflow.id)
    runId = run.id
    await until(async () => Boolean((await persistedRun(dir, run.id))?.journal[0]?.threadId), 'persisted agent step')
    threadId = first.host.requests[0].threadId
    await stop(first)
  } catch (error) {
    await drop(first)
    throw error
  }

  // Seed the collectable outcome before the engine starts, since recovery
  // replays immediately on start.
  const second = await rig(dir, 'reborn', (host) => {
    host.collectable.set(threadId, { status: 'success', changedFiles: 2, threadId, summary: 'finished offline' })
  })
  try {
    await until(() => runOf(second, runId).status === 'completed', 'recovery')
    assert.equal(second.host.requests.length, 0)
    assert.equal(runOf(second, runId).result, 'finished offline')
  } finally {
    await drop(second)
  }
})

test('editing the script mid-run invalidates the journal tail and resumes with the new steps', async () => {
  const first = await rig()
  const dir = first.dir
  let runId = ''
  let workflowId = ''
  try {
    const workflow = await first.engine.create(definition(`log('same'); const ev = await waitFor({ type: 'old.event' }); return 'old'`))
    workflowId = workflow.id
    const run = await first.engine.runNow(workflow.id)
    runId = run.id
    await until(async () => (await persistedRun(dir, run.id))?.status === 'waiting', 'persisted waiting state')
    await stop(first)
  } catch (error) {
    await drop(first)
    throw error
  }

  // Edit the workflow, then restart: the replay reuses the log step, drops
  // the stale wait (and its old subscription), and parks on the new pattern.
  const second = await rig(dir, 'edited')
  let third: Rig | undefined
  try {
    await second.engine.update(workflowId, { script: `log('same'); const ev = await waitFor({ type: 'new.event' }); return 'new:' + ev.data.tag` })
    await stop(second)

    third = await rig(dir, 'reborn')
    // Wait until the replay dropped the stale tail and parked on the new
    // pattern's subscription.
    await until(
      async () => (await third!.bus.list()).some((item) => item.pattern?.type === 'new.event'),
      'new wait subscribed'
    )
    assert.match(runOf(third, runId).note ?? '', /script changed/)
    // The old pattern must be gone: publishing it changes nothing.
    await third.bus.publish({ id: 'o', type: 'old.event', at: now, data: { tag: 'stale' } })
    assert.equal(runOf(third, runId).status, 'waiting')

    await third.bus.publish({ id: 'n', type: 'new.event', at: now, data: { tag: 'fresh' } })
    await until(() => runOf(third!, runId).status === 'completed', 'completion')
    const done = runOf(third, runId)
    assert.equal(done.result, 'new:fresh')
    assert.match(done.note ?? '', /script changed/)
    assert.equal(done.journal.filter((entry) => entry.op === 'log').length, 1)
  } finally {
    if (third) await drop(third)
    else await drop(second)
  }
})

test('judge steps enforce the verdict contract and retry once', async () => {
  const rigged = await rig()
  try {
    const workflow = await rigged.engine.create(definition(`const v = await judge('monitor flapped 6 times', ['real', 'flaky']); return v.verdict`))
    const run = await rigged.engine.runNow(workflow.id)
    await until(() => rigged.host.requests.length === 1, 'judge start')
    assert.match(rigged.host.requests[0].request.prompt, /VERDICT/)

    // First answer breaks the contract: the engine retries with a firmer prompt.
    rigged.host.finish(rigged.host.requests[0].threadId, { text: 'it is probably flaky I guess' })
    await until(() => rigged.host.requests.length === 2, 'judge retry')
    assert.match(rigged.host.requests[1].request.prompt, /did not end with a valid VERDICT/)

    rigged.host.finish(rigged.host.requests[1].threadId, { text: 'REASON: recovered quickly each time\nVERDICT: flaky' })
    await until(() => runOf(rigged, run.id).status === 'completed', 'completion')
    assert.equal(runOf(rigged, run.id).result, 'flaky')
    assert.equal(runOf(rigged, run.id).usage.judgeCalls, 2)
  } finally {
    await drop(rigged)
  }
})

test('budgets end the run as needs-attention with a notification', async () => {
  const rigged = await rig()
  try {
    const workflow = await rigged.engine.create(
      definition(`await agent('one'); await agent('two'); return 'never'`, { budget: { maxAgentRuns: 1 } })
    )
    const run = await rigged.engine.runNow(workflow.id)
    await until(() => rigged.host.requests.length === 1, 'first agent')
    rigged.host.finish(rigged.host.requests[0].threadId, { summary: 'ok' })
    await until(() => runOf(rigged, run.id).status === 'needs-attention', 'needs attention')
    assert.match(runOf(rigged, run.id).error ?? '', /Budget exceeded/)
    assert.ok(rigged.host.notices.some((notice) => notice.attention))
    assert.equal(rigged.host.requests.length, 1)
  } finally {
    await drop(rigged)
  }
})

test('state persists across runs of the same workflow', async () => {
  const rigged = await rig()
  try {
    const workflow = await rigged.engine.create(
      definition(`const count = ((await state.get('count')) ?? 0) + 1; await state.set('count', count); return count`)
    )
    const firstRun = await rigged.engine.runNow(workflow.id)
    await until(() => runOf(rigged, firstRun.id).status === 'completed', 'first run')
    assert.equal(runOf(rigged, firstRun.id).result, 1)
    const secondRun = await rigged.engine.runNow(workflow.id)
    await until(() => runOf(rigged, secondRun.id).status === 'completed', 'second run')
    assert.equal(runOf(rigged, secondRun.id).result, 2)
  } finally {
    await drop(rigged)
  }
})

test('ask parks the run until the user answers', async () => {
  const rigged = await rig()
  try {
    const workflow = await rigged.engine.create(definition(`const answer = await ask('merge it?', ['yes', 'no']); return answer`))
    const run = await rigged.engine.runNow(workflow.id)
    await until(() => runOf(rigged, run.id).status === 'waiting', 'waiting on answer')
    assert.ok(rigged.host.notices.some((notice) => notice.attention && notice.body.includes('merge it?')))
    const entry = runOf(rigged, run.id).journal.find((item) => item.op === 'ask')
    assert.ok(entry)
    await rigged.engine.answer(run.id, entry!.seq, 'yes')
    await until(() => runOf(rigged, run.id).status === 'completed', 'completion')
    assert.equal(runOf(rigged, run.id).result, 'yes')
  } finally {
    await drop(rigged)
  }
})

test('cron triggers start runs and the overlap policy records skips', async () => {
  const rigged = await rig()
  try {
    // Pin the clock off any five-minute boundary before the trigger registers.
    rigged.setNow(1_000_000_000 + 123_456)
    await rigged.engine.create(
      definition(`await waitFor({ type: 'never.event' }); return 'x'`, {
        name: 'Watcher',
        triggers: [{ kind: 'cron', expression: '*/5 * * * *' }]
      })
    )
    const nextFire = Math.floor(now / 300_000 + 1) * 300_000
    rigged.setNow(nextFire)
    await rigged.bus.tick()
    await until(() => rigged.store.runs.length === 1, 'first cron run')
    assert.equal(rigged.store.runs[0].trigger, 'cron')
    await until(() => rigged.store.runs[0].status === 'waiting', 'first run waiting')

    rigged.setNow(nextFire + 300_000)
    await rigged.bus.tick()
    await until(() => rigged.store.runs.length === 2, 'second cron fire')
    const skipped = rigged.store.runs.find((item: WorkflowRun) => item.status === 'skipped')
    assert.ok(skipped, 'second fire was skipped while the first run is active')
  } finally {
    await drop(rigged)
  }
})

test('the wall-clock deadline ends a stuck run as needs-attention', async () => {
  const rigged = await rig()
  try {
    const workflow = await rigged.engine.create(
      definition(`await waitFor({ type: 'never.event' }); return 'x'`, { budget: { maxRunHours: 1 } })
    )
    const run = await rigged.engine.runNow(workflow.id)
    await until(() => runOf(rigged, run.id).status === 'waiting', 'waiting')
    rigged.setNow(now + 2 * 3_600_000)
    await rigged.bus.tick()
    await until(() => runOf(rigged, run.id).status === 'needs-attention', 'deadline')
    assert.match(runOf(rigged, run.id).error ?? '', /wall-clock/)
  } finally {
    await drop(rigged)
  }
})

test('stopping a run aborts its in-flight agents', async () => {
  const rigged = await rig()
  try {
    const workflow = await rigged.engine.create(definition(`await agent('endless'); return 'x'`))
    const run = await rigged.engine.runNow(workflow.id)
    await until(() => rigged.host.requests.length === 1, 'agent start')
    await rigged.engine.stopRun(run.id)
    assert.equal(runOf(rigged, run.id).status, 'stopped')
    assert.deepEqual(rigged.host.aborted, [rigged.host.requests[0].threadId])
    assert.equal((await rigged.bus.list()).length, 0)
  } finally {
    await drop(rigged)
  }
})

test('agent failures surface to the script, which can escalate', async () => {
  const rigged = await rig()
  try {
    const workflow = await rigged.engine.create(
      definition(
        `const first = await agent('try cheap');\n` +
          `if (first.status !== 'success') { const second = await agent('try expensive'); return 'escalated:' + second.summary }\n` +
          `return first.summary`
      )
    )
    const run = await rigged.engine.runNow(workflow.id)
    await until(() => rigged.host.requests.length === 1, 'first agent')
    rigged.host.finish(rigged.host.requests[0].threadId, { status: 'failure', error: 'could not fix' })
    await until(() => rigged.host.requests.length === 2, 'escalation agent')
    rigged.host.finish(rigged.host.requests[1].threadId, { summary: 'fixed properly' })
    await until(() => runOf(rigged, run.id).status === 'completed', 'completion')
    assert.equal(runOf(rigged, run.id).result, 'escalated:fixed properly')
  } finally {
    await drop(rigged)
  }
})

test('a run started by a thread delivers its result back to that thread', async () => {
  const rigged = await rig()
  try {
    const workflow = await rigged.engine.create(definition(`log('checking'); return 'all clear'`))
    const run = await rigged.engine.runNow(workflow.id, undefined, { startedByThreadId: 'caller-thread' })
    await until(() => runOf(rigged, run.id).status === 'completed', 'completion')
    await until(() => rigged.host.delivered.length === 1, 'delivery')
    assert.equal(rigged.host.delivered[0].threadId, 'caller-thread')
    assert.match(rigged.host.delivered[0].body, /BOSS WORKFLOW RESULT/)
    assert.match(rigged.host.delivered[0].body, /completed/)
    assert.match(rigged.host.delivered[0].body, /all clear/)
  } finally {
    await drop(rigged)
  }
})

test('the approval mode persists and rides the snapshot', async () => {
  const first = await rig()
  const dir = first.dir
  try {
    assert.equal(first.engine.snapshot().approvalMode, 'ask')
    await first.engine.setApprovalMode('auto')
    assert.equal(first.engine.snapshot().approvalMode, 'auto')
    await stop(first)
  } catch (error) {
    await drop(first)
    throw error
  }

  const second = await rig(dir, 'reborn')
  try {
    assert.equal(second.engine.snapshot().approvalMode, 'auto')
  } finally {
    await drop(second)
  }
})
