import assert from 'node:assert/strict'
import test from 'node:test'
// Node's type-stripping test runner requires explicit extensions.
// @ts-expect-error Application code uses bundler resolution.
import { MOBILE_PAGE } from './mobile-page.ts'
// @ts-expect-error Application code uses bundler resolution.
import { mobileRequestAllowed } from '../shared/mobile.ts'

test('mobile page contains valid JavaScript and uses the shared supervision API', () => {
  const match = MOBILE_PAGE.match(/<script>([\s\S]*)<\/script>/)
  assert.ok(match?.[1], 'embedded script missing')
  assert.doesNotThrow(() => new Function(match[1]))
  assert.match(match[1], /supervision\.snapshot/)
  assert.match(match[1], /api\/access/)
})

test('read-only access cannot mutate task or automation state', () => {
  for (const type of [
    'thread.send',
    'thread.abort',
    'thread.permission',
    'thread.delegate',
    'thread.relay',
    'automation.run',
    'automation.stop'
  ] as const) {
    assert.equal(mobileRequestAllowed(type, 'read-only'), false, type)
    assert.equal(mobileRequestAllowed(type, 'control'), true, type)
  }
})

test('read-only access can inspect supervision and transcripts', () => {
  for (const type of [
    'supervision.snapshot',
    'supervision.search',
    'thread.list',
    'thread.messages',
    'thread.diff',
    'automation.list'
  ] as const) {
    assert.equal(mobileRequestAllowed(type, 'read-only'), true, type)
  }
})
