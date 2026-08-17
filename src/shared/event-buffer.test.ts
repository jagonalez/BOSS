import assert from 'node:assert/strict'
import test from 'node:test'
// Node's type-stripping test runner requires explicit extensions.
// @ts-expect-error Application code uses bundler resolution.
import { EventBuffer } from './event-buffer.ts'

const event = (n: number): Record<string, unknown> => ({ type: 'message.updated', n })

test('events are numbered from one and handed back in order', () => {
  const buffer = new EventBuffer(10)
  assert.equal(buffer.push(event(1)), 1)
  assert.equal(buffer.push(event(2)), 2)
  assert.equal(buffer.latest, 2)
  assert.deepEqual(buffer.since(0).events.map((e) => e.seq), [])
  assert.deepEqual(buffer.since(1).events.map((e) => e.seq), [2])
})

test('a phone that missed a burst gets exactly what it missed', () => {
  const buffer = new EventBuffer(100)
  for (let i = 0; i < 20; i += 1) buffer.push(event(i))
  const result = buffer.since(12)
  assert.equal(result.gap, false)
  assert.deepEqual(result.events.map((e) => e.seq), [13, 14, 15, 16, 17, 18, 19, 20])
})

test('a caught-up phone gets nothing and no gap', () => {
  const buffer = new EventBuffer(10)
  buffer.push(event(1))
  buffer.push(event(2))
  const result = buffer.since(2)
  assert.deepEqual(result.events, [])
  assert.equal(result.gap, false)
})

test('a brand new phone is not told there is a gap', () => {
  const buffer = new EventBuffer(4)
  for (let i = 0; i < 50; i += 1) buffer.push(event(i))
  // since=0 means "never applied anything"; it loads current state instead.
  const result = buffer.since(0)
  assert.equal(result.gap, false)
  assert.deepEqual(result.events, [])
  assert.equal(result.seq, 50)
})

test('falling behind the buffer reports a gap rather than a partial stream', () => {
  const buffer = new EventBuffer(5)
  for (let i = 0; i < 20; i += 1) buffer.push(event(i))
  // Holds 16..20. A phone at 3 needs 4, which is long gone.
  const result = buffer.since(3)
  assert.equal(result.gap, true, 'a hole must be reported, never silently skipped')
  assert.deepEqual(result.events, [])
  assert.equal(result.seq, 20, 'the phone still learns where to resync to')
})

test('the exact boundary of the buffer is not a gap', () => {
  const buffer = new EventBuffer(5)
  for (let i = 0; i < 20; i += 1) buffer.push(event(i))
  // Oldest held is 16, so a phone at 15 needs 16 — still present.
  const boundary = buffer.since(15)
  assert.equal(boundary.gap, false)
  assert.deepEqual(boundary.events.map((e) => e.seq), [16, 17, 18, 19, 20])
  // One older than that is a genuine gap.
  assert.equal(buffer.since(14).gap, true)
})

test('the buffer never grows past its capacity', () => {
  const buffer = new EventBuffer(50)
  for (let i = 0; i < 5000; i += 1) buffer.push(event(i))
  assert.equal(buffer.size, 50)
  assert.equal(buffer.latest, 5000)
})

test('a desktop restart is treated as a gap, not an endless wait', () => {
  // The phone remembers seq 400; the desktop restarted and is only at 3.
  const buffer = new EventBuffer(10)
  buffer.push(event(1))
  buffer.push(event(2))
  buffer.push(event(3))
  const result = buffer.since(400)
  assert.equal(result.gap, true, 'otherwise the phone waits for events that will never arrive')
  assert.equal(result.seq, 3)
})
