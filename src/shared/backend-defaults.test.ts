import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Application code uses bundler resolution.
import { isAbortError, isBackendId, withBackendDefaults } from './backend.ts'

test('new child threads receive the configured model, thinking, and permissions', () => {
  assert.deepEqual(
    withBackendDefaults({
      providerID: 'openai',
      modelID: 'gpt-5.6-sol',
      variant: 'high',
      mode: 'auto'
    }),
    {
      model: { providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'high' },
      mode: 'auto'
    }
  )
})

test('explicit thread settings override backend defaults', () => {
  assert.deepEqual(
    withBackendDefaults(
      { providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'high', mode: 'auto' },
      { model: { providerID: 'anthropic', modelID: 'claude-opus', variant: 'max' }, mode: 'plan' }
    ),
    {
      model: { providerID: 'anthropic', modelID: 'claude-opus', variant: 'max' },
      mode: 'plan'
    }
  )
})

test('an explicit model still receives the configured permission mode', () => {
  assert.deepEqual(
    withBackendDefaults(
      { providerID: 'openai', modelID: 'gpt-5.6-sol', mode: 'auto' },
      { model: { providerID: 'openai', modelID: 'gpt-5.5' } },
      'ask'
    ),
    {
      model: { providerID: 'openai', modelID: 'gpt-5.5' },
      mode: 'auto'
    }
  )
})

test('creation fallback is used only when no permission default is configured', () => {
  assert.equal(withBackendDefaults(undefined, undefined, 'ask').mode, 'ask')
  assert.equal(
    withBackendDefaults({ providerID: 'openai', modelID: 'gpt-5.6-sol', mode: 'plan' }, undefined, 'ask').mode,
    'plan'
  )
})

test('spawn agent ids accept configured backends and reject unknown agents', () => {
  assert.equal(isBackendId('codex'), true)
  assert.equal(isBackendId('claude'), true)
  assert.equal(isBackendId('other'), false)
})

test('a stop a backend reports as an error is recognised as the stop', () => {
  // What opencode sends when BOSS aborts a run for Stop or Stop & redirect.
  assert.equal(isAbortError({ name: 'MessageAbortedError', message: 'Aborted' }), true)
  assert.equal(isAbortError('MessageAbortedError: Aborted'), true)
  assert.equal(isAbortError({ data: { message: 'The request was cancelled' } }), true)
  assert.equal(isAbortError(new Error('operation aborted')), true)
})

test('a real failure is never mistaken for a stop', () => {
  // The thread was stopped on purpose, but this is not why it ended, so the
  // user still has to see it.
  assert.equal(isAbortError({ name: 'Error', message: 'Connection refused' }), false)
  assert.equal(isAbortError('Claude Code exited with 1.'), false)
  assert.equal(isAbortError(undefined), false)
  assert.equal(isAbortError({}), false)
  // Substrings of longer words are not the word.
  assert.equal(isAbortError('abortive retry strategy failed'), false)
})
