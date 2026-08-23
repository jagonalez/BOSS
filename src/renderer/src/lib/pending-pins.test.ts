import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Application code uses bundler resolution.
import { PendingPins } from './pending-pins.ts'
import type { SessionInfo } from '../../../shared/opencode.ts'

function sessions(pinned = false): SessionInfo[] {
  return [{ id: 'one', pinned }, { id: 'two' }]
}

test('a refresh cannot overwrite a pin that main has not acknowledged', () => {
  const pending = new PendingPins()
  pending.begin('one', true)
  assert.equal(pending.apply(sessions(false))[0].pinned, true)
})

test('only the latest click can settle a thread pin', () => {
  const pending = new PendingPins()
  const first = pending.begin('one', true)
  const second = pending.begin('one', false)

  assert.equal(pending.settle('one', first), false)
  assert.equal(pending.apply(sessions(true))[0].pinned, false)
  assert.equal(pending.settle('one', second), true)
  assert.equal(pending.apply(sessions(true))[0].pinned, true)
})

test('pending choices are isolated by thread', () => {
  const pending = new PendingPins()
  pending.begin('one', true)
  pending.begin('two', false)
  assert.deepEqual(pending.apply([{ id: 'one' }, { id: 'two', pinned: true }]).map((item) => item.pinned), [true, false])
})
