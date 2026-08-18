import assert from 'node:assert/strict'
import test from 'node:test'
// Node's type-stripping test runner requires explicit extensions.
// @ts-expect-error Application code uses bundler resolution.
import { titleFromFirstPrompt } from './thread-title.ts'

test('derives a compact title from a new thread’s first text prompt', () => {
  assert.equal(
    titleFromFirstPrompt('Untitled Codex thread', [{ type: 'text', text: 'Can you fix the flaky sign-in test?' }]),
    'fix the flaky sign-in test'
  )
})

test('does not replace a user-entered title or name an attachment-only prompt', () => {
  assert.equal(titleFromFirstPrompt('Release checklist', [{ type: 'text', text: 'Review it' }]), undefined)
  assert.equal(titleFromFirstPrompt(undefined, [{ type: 'file', filename: 'brief.pdf' }]), undefined)
})

test('keeps locally derived titles short at a word boundary', () => {
  const title = titleFromFirstPrompt(undefined, [{ type: 'text', text: 'Investigate why the renderer can no longer restore a sidebar width after the application restarts unexpectedly' }])
  assert.equal(title, 'Investigate why the renderer can no longer restore a sidebar width…')
})
