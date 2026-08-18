import assert from 'node:assert/strict'
import test from 'node:test'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error Application code uses bundler resolution.
import { backendVersionWarning, parseBackendVersion } from './backend-version.ts'

test('reads a version out of each CLI\'s own --version wording', () => {
  // The three backends answer differently, and a parser that assumed the
  // number came first read "codex-cli 0.147.0" as 0.
  assert.equal(parseBackendVersion('codex-cli 0.147.0'), '0.147.0')
  assert.equal(parseBackendVersion('0.84.1'), '0.84.1')
  assert.equal(parseBackendVersion('2.1.234 (Claude Code)'), '2.1.234')
})

test('reports no version when the output has no number in it', () => {
  assert.equal(parseBackendVersion(undefined), undefined)
  assert.equal(parseBackendVersion(''), undefined)
  assert.equal(parseBackendVersion('command not found'), undefined)
})

test('stays quiet for a version at or above the floor', () => {
  assert.equal(backendVersionWarning('codex', 'codex-cli 0.147.0'), undefined)
  assert.equal(backendVersionWarning('claude', '2.1.234 (Claude Code)'), undefined)
  assert.equal(backendVersionWarning('pi', '0.84.1'), undefined)
})

test('names the version and the floor when a CLI is too old', () => {
  const warning = backendVersionWarning('codex', 'codex-cli 0.9.0')
  assert.match(String(warning), /0\.9\.0/)
  assert.match(String(warning), /0\.100\.0/)
})

test('compares numerically rather than lexically', () => {
  // 0.9.0 is older than 0.100.0 even though it sorts after it as text.
  assert.ok(backendVersionWarning('codex', '0.9.0'))
  assert.equal(backendVersionWarning('codex', '0.100.0'), undefined)
})

test('says so when a backend answers in a shape it cannot read', () => {
  // Also how a renamed or wrapped binary looks, which is worth surfacing.
  assert.match(String(backendVersionWarning('codex', 'some-wrapper')), /could not read a version/)
})

test('leaves the bundled backend alone', () => {
  // opencode ships with BOSS, so its version is pinned and there is no user
  // upgrade that could surprise us.
  assert.equal(backendVersionWarning('opencode', '1.18.15'), undefined)
})
