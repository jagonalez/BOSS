import assert from 'node:assert/strict'
import test from 'node:test'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error Application code uses bundler resolution.
import { SessionDirectories } from './session-directory.ts'

test('a thread runs in its own checkout, not the last project selected', () => {
  // What went wrong: a thread in the ralf project reported /Users/jeremy/dev/
  // autofix, reasoned about the wrong repository, and on codex would have been
  // given write access to it.
  const directories = new SessionDirectories()
  directories.set('thread-ralf', '/src/ralf')
  directories.set('thread-autofix', '/src/autofix')

  assert.equal(directories.resolve('thread-ralf', '/src/kato'), '/src/ralf')
  assert.equal(directories.resolve('thread-autofix', '/src/kato'), '/src/autofix')
})

test('a thread with no checkout of its own falls back to the current project', () => {
  const directories = new SessionDirectories()
  assert.equal(directories.resolve('thread-new', '/src/kato'), '/src/kato')
  assert.equal(directories.resolve('thread-new', ''), undefined)
})

test('a checkout is not replaced by an empty one', () => {
  // The manager passes a binding's executionPath, which is empty while a
  // thread's project is unresolved. Taking it would undo a good answer.
  const directories = new SessionDirectories()
  directories.set('thread-1', '/src/ralf')
  directories.set('thread-1', '')
  assert.equal(directories.resolve('thread-1', '/src/kato'), '/src/ralf')
})

test('a closed thread stops being remembered', () => {
  const directories = new SessionDirectories()
  directories.set('thread-1', '/src/ralf')
  directories.forget('thread-1')
  assert.equal(directories.resolve('thread-1', '/src/kato'), '/src/kato')
})
