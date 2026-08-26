import assert from 'node:assert/strict'
import test from 'node:test'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error Application code uses bundler resolution.
import { clampResult, hashArgs, matchesPattern, parseJudgeOutcome } from './workflow.ts'
import type { BossEvent } from './workflow.ts'

function event(type: string, data: Record<string, unknown> = {}, projectPath?: string): BossEvent {
  return { id: 'e1', type, at: 1, data, ...(projectPath !== undefined ? { projectPath } : {}) }
}

test('matchesPattern matches exact types and prefix wildcards', () => {
  assert.equal(matchesPattern({ type: 'github.push' }, event('github.push')), true)
  assert.equal(matchesPattern({ type: 'github.push' }, event('github.pull_request')), false)
  assert.equal(matchesPattern({ type: 'github.*' }, event('github.pull_request')), true)
  assert.equal(matchesPattern({ type: 'github.*' }, event('cron.fired')), false)
  assert.equal(matchesPattern({ type: '*' }, event('anything.at.all')), true)
})

test('matchesPattern applies project and data filters', () => {
  assert.equal(matchesPattern({ type: 'ci.completed', projectPath: '/a' }, event('ci.completed', {}, '/a')), true)
  assert.equal(matchesPattern({ type: 'ci.completed', projectPath: '/a' }, event('ci.completed', {}, '/b')), false)
  assert.equal(matchesPattern({ type: 'ci.completed', projectPath: '' }, event('ci.completed', {})), true)
  assert.equal(matchesPattern({ type: 'ci.*', filters: { branch: 'main' } }, event('ci.completed', { branch: 'main' })), true)
  assert.equal(matchesPattern({ type: 'ci.*', filters: { branch: 'main' } }, event('ci.completed', { branch: 'dev' })), false)
  assert.equal(matchesPattern({ type: 'ci.*', filters: { attempt: 2 } }, event('ci.completed', { attempt: '2' })), true)
})

test('hashArgs is stable across key order and sensitive to values', () => {
  assert.equal(hashArgs('agent', { a: 1, b: [2, 3] }), hashArgs('agent', { b: [2, 3], a: 1 }))
  assert.notEqual(hashArgs('agent', { a: 1 }), hashArgs('agent', { a: 2 }))
  assert.notEqual(hashArgs('agent', { a: 1 }), hashArgs('judge', { a: 1 }))
  assert.equal(hashArgs('x', { a: undefined, b: 1 }), hashArgs('x', { b: 1 }))
})

test('parseJudgeOutcome reads the final-line contract case-insensitively', () => {
  const text = 'Thinking...\nREASON: recovered five times in a row\nVERDICT: Flaky'
  assert.deepEqual(parseJudgeOutcome(text, ['real', 'flaky']), { verdict: 'flaky', reason: 'recovered five times in a row' })
  assert.equal(parseJudgeOutcome('no verdict here', ['a', 'b']), null)
  assert.equal(parseJudgeOutcome('VERDICT: maybe', ['a', 'b']), null)
  assert.equal(parseJudgeOutcome(undefined, ['a', 'b']), null)
})

test('clampResult keeps JSON-safe values and truncates the huge ones', () => {
  assert.deepEqual(clampResult({ a: 1, b: 'x', c: [true, null] }), { a: 1, b: 'x', c: [true, null] })
  assert.equal(clampResult(undefined), null)
  assert.equal(clampResult(Number.NaN), null)
  const long = clampResult('y'.repeat(50_000)) as string
  assert.ok(long.length < 40_000)
  assert.ok(long.endsWith('[truncated]'))
  const nested = clampResult({ fn: () => 1, keep: 2 }) as Record<string, unknown>
  assert.deepEqual(nested, { keep: 2 })
})
