import { strict as assert } from 'node:assert'
import { test } from 'node:test'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error TypeScript's bundler resolution omits it in application code.
import { isNewer } from './version.ts'

test('detects a newer patch, minor, and major', () => {
  assert.equal(isNewer('0.1.1', '0.1.0'), true)
  assert.equal(isNewer('0.2.0', '0.1.9'), true)
  assert.equal(isNewer('1.0.0', '0.9.9'), true)
})

test('rejects same or older versions', () => {
  assert.equal(isNewer('0.1.0', '0.1.0'), false)
  assert.equal(isNewer('0.1.0', '0.1.1'), false)
  assert.equal(isNewer('0.9.9', '1.0.0'), false)
})

test('tolerates a v prefix and uneven segment counts', () => {
  assert.equal(isNewer('v0.2.0', '0.1.0'), true)
  assert.equal(isNewer('0.2', '0.1.9'), true)
  assert.equal(isNewer('0.1', '0.1.0'), false)
})

test('compares numerically rather than lexically', () => {
  // '10' sorts before '9' as a string; it must not here.
  assert.equal(isNewer('0.10.0', '0.9.0'), true)
  assert.equal(isNewer('0.9.0', '0.10.0'), false)
})

test('ignores prerelease suffixes when comparing', () => {
  assert.equal(isNewer('0.2.0-beta.1', '0.1.0'), true)
  assert.equal(isNewer('0.1.0-beta.1', '0.1.0'), false)
})
