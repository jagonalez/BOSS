import assert from 'node:assert/strict'
import test from 'node:test'
// Node's type-stripping test runner requires explicit extensions.
// @ts-expect-error Application code uses bundler resolution.
import { fanOutTitle, fanOutViolation, FAN_OUT_MAX_WORKERS } from './fan-out.ts'
import type { FanOutWorker } from './fan-out.ts'

const worker = (backendId: FanOutWorker['backendId'], label?: string): FanOutWorker => ({ backendId, label })

test('rejects a fan-out that cannot produce a comparison', () => {
  assert.match(fanOutViolation([]) ?? '', /at least 2/)
  assert.match(fanOutViolation([worker('claude')]) ?? '', /Delegate instead/)
})

test('accepts two through the maximum', () => {
  assert.equal(fanOutViolation([worker('claude'), worker('codex')]), undefined)
  const most = Array.from({ length: FAN_OUT_MAX_WORKERS }, () => worker('claude'))
  assert.equal(fanOutViolation(most), undefined)
})

test('caps the number of workers', () => {
  const tooMany = Array.from({ length: FAN_OUT_MAX_WORKERS + 1 }, () => worker('claude'))
  assert.match(fanOutViolation(tooMany) ?? '', /capped at/)
})

test('keeps two attempts on one backend distinguishable', () => {
  const task = 'fix the race'
  const first = fanOutTitle(task, worker('claude'), 0)
  const second = fanOutTitle(task, worker('claude'), 1)
  assert.notEqual(first, second)
  assert.match(first, /#1/)
  assert.match(second, /#2/)
})

test('prefers an explicit label over the position', () => {
  assert.match(fanOutTitle('fix the race', worker('claude', 'cautious'), 0), /cautious/)
})

test('falls back to the position when a label is blank', () => {
  assert.match(fanOutTitle('fix the race', worker('claude', '   '), 2), /#3/)
})

test('truncates a long task in the title', () => {
  const title = fanOutTitle('x'.repeat(120), worker('codex'), 0)
  assert.ok(title.length < 70, title)
  assert.match(title, /…$/)
})
