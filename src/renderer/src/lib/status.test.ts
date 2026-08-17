import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Application code uses bundler resolution.
import { threadIsWorking, turnCompletedAt } from './status.ts'

test('a thread is working while the latest event says it is busy', () => {
  assert.equal(threadIsWorking(true, false, false), true)
  assert.equal(threadIsWorking(false, true, false), false)
})

test('a window that never saw the event reads the thread itself', () => {
  // Opening or reloading mid-run leaves no event to have seen. Main publishes
  // busy on the thread for exactly this case.
  assert.equal(threadIsWorking(undefined, true, false), true)
  assert.equal(threadIsWorking(undefined, false, false), false)
})

test('a thread nobody has said anything about is not working', () => {
  assert.equal(threadIsWorking(undefined, undefined, undefined), false)
})

test('compacting counts as working', () => {
  assert.equal(threadIsWorking(false, false, true), true)
})

test('a turn is finished only once every message in it is', () => {
  assert.equal(turnCompletedAt([100, 250, 180]), 250)
  // The bug: one message still running, and the turn reported itself done —
  // which is the field that decides whether the thread still looks busy.
  assert.equal(turnCompletedAt([100, undefined]), undefined)
  assert.equal(turnCompletedAt([undefined]), undefined)
})

test('a turn with no messages has no completion', () => {
  // Math.max of nothing is -Infinity, which would read as a real timestamp.
  assert.equal(turnCompletedAt([]), undefined)
})
