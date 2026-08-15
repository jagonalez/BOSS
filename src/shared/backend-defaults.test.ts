import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Application code uses bundler resolution.
import { isBackendId, withBackendDefaults } from './backend.ts'

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
