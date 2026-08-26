import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BossEvent, WorkflowSubscription } from '../shared/workflow.ts'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error Application code uses bundler resolution.
import { EventBus } from './event-bus.ts'

interface Fired {
  subscription: WorkflowSubscription
  event: BossEvent | null
}

async function withBus(
  run: (tools: { bus: EventBus; fired: Fired[]; file: string; setNow: (value: number) => void }) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'boss-bus-'))
  const file = join(dir, 'bus.json')
  let now = 0
  const bus = new EventBus(file, { now: () => now })
  const fired: Fired[] = []
  bus.onFire((subscription, event) => {
    fired.push({ subscription, event })
  })
  try {
    await run({ bus, fired, file, setNow: (value) => (now = value) })
  } finally {
    bus.stop()
    await rm(dir, { recursive: true, force: true })
  }
}

function event(type: string, data: Record<string, unknown> = {}): BossEvent {
  return { id: `event-${type}`, type, at: 0, data }
}

test('publish delivers to matching subscriptions and removes one-shot resumes', async () => {
  await withBus(async ({ bus, fired }) => {
    await bus.subscribe({ target: { kind: 'resume', runId: 'r1', seq: 0 }, pattern: { type: 'ci.*' } })
    await bus.subscribe({ target: { kind: 'trigger', workflowId: 'w1' }, pattern: { type: 'ci.completed' } })
    await bus.subscribe({ target: { kind: 'trigger', workflowId: 'w2' }, pattern: { type: 'other.event' } })

    await bus.publish(event('ci.completed', { branch: 'main' }))
    assert.equal(fired.length, 2)

    // The resume subscription was one-shot; the trigger persists.
    await bus.publish(event('ci.completed'))
    assert.equal(fired.length, 3)
    assert.equal(fired[2].subscription.target.kind, 'trigger')
  })
})

test('cron subscriptions fire on schedule and reschedule themselves', async () => {
  await withBus(async ({ bus, fired, setNow }) => {
    await bus.subscribe({ target: { kind: 'trigger', workflowId: 'w1' }, cron: { expression: '*/5 * * * *', nextAt: 0 } })
    await bus.tick()
    assert.equal(fired.length, 0)

    setNow(5 * 60_000)
    await bus.tick()
    assert.equal(fired.length, 1)
    assert.equal(fired[0].event?.type, 'cron.fired')

    // Same tick window does not double-fire.
    await bus.tick()
    assert.equal(fired.length, 1)

    setNow(10 * 60_000)
    await bus.tick()
    assert.equal(fired.length, 2)
  })
})

test('timers expire with a null event and are removed', async () => {
  await withBus(async ({ bus, fired, setNow }) => {
    await bus.subscribe({ target: { kind: 'resume', runId: 'r1', seq: 3 }, expiresAt: 1_000 })
    await bus.subscribe({ target: { kind: 'resume', runId: 'r1', seq: 4 }, pattern: { type: 'never.fires' }, expiresAt: 2_000 })
    await bus.tick()
    assert.equal(fired.length, 0)

    setNow(1_500)
    await bus.tick()
    assert.equal(fired.length, 1)
    assert.equal(fired[0].event, null)
    assert.deepEqual(fired[0].subscription.target, { kind: 'resume', runId: 'r1', seq: 3 })

    setNow(2_500)
    await bus.tick()
    assert.equal(fired.length, 2)
    assert.equal((await bus.list()).length, 0)
  })
})

test('a waitFor subscription resolved by its event never also expires', async () => {
  await withBus(async ({ bus, fired, setNow }) => {
    await bus.subscribe({ target: { kind: 'resume', runId: 'r1', seq: 0 }, pattern: { type: 'pr.review' }, expiresAt: 5_000 })
    await bus.publish(event('pr.review'))
    assert.equal(fired.length, 1)
    setNow(10_000)
    await bus.tick()
    assert.equal(fired.length, 1)
  })
})

test('unsubscribeTarget clears everything pointing at a run or workflow', async () => {
  await withBus(async ({ bus }) => {
    await bus.subscribe({ target: { kind: 'resume', runId: 'r1', seq: 0 }, pattern: { type: 'a' } })
    await bus.subscribe({ target: { kind: 'resume', runId: 'r2', seq: 0 }, pattern: { type: 'a' } })
    await bus.subscribe({ target: { kind: 'trigger', workflowId: 'w1' }, pattern: { type: 'a' } })
    await bus.unsubscribeTarget({ runId: 'r1', workflowId: 'w1' })
    const left = await bus.list()
    assert.equal(left.length, 1)
    assert.deepEqual(left[0].target, { kind: 'resume', runId: 'r2', seq: 0 })
  })
})

test('subscriptions survive a restart through the state file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'boss-bus-'))
  const file = join(dir, 'bus.json')
  try {
    const first = new EventBus(file, { now: () => 0 })
    await first.subscribe({ target: { kind: 'resume', runId: 'r1', seq: 2 }, pattern: { type: 'ci.completed' } })
    first.stop()

    const fired: Fired[] = []
    const second = new EventBus(file, { now: () => 0 })
    second.onFire((subscription, event) => {
      fired.push({ subscription, event })
    })
    await second.publish(event('ci.completed'))
    assert.equal(fired.length, 1)
    assert.deepEqual(fired[0].subscription.target, { kind: 'resume', runId: 'r1', seq: 2 })
    second.stop()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
