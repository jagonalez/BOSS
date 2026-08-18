import assert from 'node:assert/strict'
import test from 'node:test'
// Node's type-stripping test runner requires explicit extensions.
// @ts-expect-error Application code uses bundler resolution.
import { shouldNotify } from './notification.ts'
import type { BossEventType } from './notification.ts'

const EVERY: BossEventType[] = [
  'task.completed',
  'task.failed',
  'task.needs_attention',
  'automation.completed',
  'automation.failed',
  'review.completed'
]

test('off silences everything', () => {
  for (const type of EVERY) assert.equal(shouldNotify('off', type), false, type)
})

test('all lets everything through', () => {
  for (const type of EVERY) assert.equal(shouldNotify('all', type), true, type)
})

test('attention keeps what blocks progress and drops routine completions', () => {
  assert.equal(shouldNotify('attention', 'task.needs_attention'), true)
  assert.equal(shouldNotify('attention', 'task.failed'), true)
  assert.equal(shouldNotify('attention', 'automation.failed'), true)
  // A reviewer's verdict is worth interrupting for: it is the answer the user
  // was waiting on, not routine progress.
  assert.equal(shouldNotify('attention', 'review.completed'), true)
  assert.equal(shouldNotify('attention', 'task.completed'), false)
  assert.equal(shouldNotify('attention', 'automation.completed'), false)
})
