import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Application code uses bundler resolution.
import { compactionCompletedEvents, compactionNotice, compactionStartedEvent } from './compaction-events.ts'

test('automatic compaction produces a durable, renderable transcript marker', () => {
  const events = compactionCompletedEvents('thread-1', {
    trigger: 'auto',
    preTokens: 180_000,
    postTokens: 24_000
  })
  assert.equal(events[0].type, 'message.updated')
  assert.equal(events[1].type, 'message.part.updated')
  assert.equal(events[2].type, 'session.compacted')

  if (events[0].type !== 'message.updated' || events[1].type !== 'message.part.updated') return
  assert.match(events[0].message.id, /^compaction-notice-/)
  assert.equal(events[0].message.role, 'user')
  assert.equal(events[1].part.messageID, events[0].message.id)
  assert.equal(events[1].part.type, 'compaction')
  assert.equal(events[1].part.auto, true)
  assert.deepEqual(events[1].part.state?.metadata, {
    trigger: 'auto',
    preTokens: 180_000,
    postTokens: 24_000
  })
})

test('manual and overflow notices do not masquerade as automatic summaries', () => {
  const manual = compactionNotice('thread-1', { trigger: 'manual' }).parts[0]
  assert.equal(manual.auto, undefined)
  assert.equal(manual.overflow, undefined)

  const overflow = compactionNotice('thread-1', { trigger: 'auto', overflow: true }).parts[0]
  assert.equal(overflow.auto, true)
  assert.equal(overflow.overflow, true)
})

test('compaction start carries the trigger independently of ordinary busy state', () => {
  assert.deepEqual(compactionStartedEvent('thread-1', 'auto'), {
    type: 'session.compaction.started',
    sessionID: 'thread-1',
    trigger: 'auto'
  })
})
