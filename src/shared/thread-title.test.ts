import assert from 'node:assert/strict'
import test from 'node:test'
// Node's type-stripping test runner requires explicit extensions.
// @ts-expect-error Application code uses bundler resolution.
import { normalizeGeneratedThreadTitle, titleFromFirstPrompt } from './thread-title.ts'

test('derives a compact title from a new thread’s first text prompt', () => {
  assert.equal(
    titleFromFirstPrompt('Untitled Codex thread', [{ type: 'text', text: 'Can you fix the flaky sign-in test?' }]),
    'Fix flaky sign-in test'
  )
})

test('does not replace a user-entered title or name an attachment-only prompt', () => {
  assert.equal(titleFromFirstPrompt('Release checklist', [{ type: 'text', text: 'Review it' }]), undefined)
  assert.equal(titleFromFirstPrompt(undefined, [{ type: 'file', filename: 'brief.pdf' }]), undefined)
})

test('replaces backend placeholder titles', () => {
  assert.equal(
    titleFromFirstPrompt('New session - 2026-08-23T12:00:00Z', [{ type: 'text', text: 'Please fix session titles.' }]),
    'Fix session titles'
  )
  assert.equal(titleFromFirstPrompt('New codex thread', [{ type: 'text', text: 'Please fix session titles.' }]), 'Fix session titles')
})

test('turns a long request into a short task label', () => {
  const title = titleFromFirstPrompt(undefined, [{ type: 'text', text: 'Investigate why the renderer can no longer restore a sidebar width after the application restarts unexpectedly' }])
  assert.equal(title, 'Investigate renderer restore sidebar width')
})

test('finds the request after opening context instead of copying the first sentence', () => {
  const title = titleFromFirstPrompt(undefined, [{
    type: 'text',
    text: 'Here is some background on authentication. The app uses OAuth today. Please fix the session refresh race after login.'
  }])
  assert.equal(title, 'Fix session refresh race login')
})

test('keeps conversational complaints out of the task label', () => {
  const title = titleFromFirstPrompt(undefined, [{
    type: 'text',
    text: 'We need to fix the "automate" thread names - it is pretty bad, because they are always super long and copy the first sentence.'
  }])
  assert.equal(title, 'Fix "automate" thread names')
})

test('accepts structured model output and keeps generated titles tab-sized', () => {
  assert.equal(normalizeGeneratedThreadTitle('{"title":"Improve automatic thread naming"}'), 'Improve automatic thread naming')
  assert.equal(
    normalizeGeneratedThreadTitle('Title: Improve the automatic names assigned to every newly created conversation in the sidebar.'),
    'Improve the automatic names assigned to every'
  )
})
