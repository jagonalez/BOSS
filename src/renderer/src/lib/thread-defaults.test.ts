import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Application code uses bundler resolution.
import { resolveMode, resolveModel, resolveVariant } from './thread-defaults.ts'

const CLAUDE = ['ask', 'auto', 'plan', 'accept-edits'] as const
const CODEX = ['ask', 'auto', 'plan'] as const
const PI = ['auto'] as const

test('a thread keeps the mode it was set to', () => {
  assert.equal(resolveMode('plan', 'auto', 'ask', [...CLAUDE]), 'plan')
})

test('a thread with no mode of its own takes the backend default', () => {
  assert.equal(resolveMode(undefined, 'accept-edits', 'ask', [...CLAUDE]), 'accept-edits')
})

test('without a backend default it falls back to the app', () => {
  assert.equal(resolveMode(undefined, undefined, 'plan', [...CLAUDE]), 'plan')
})

test('a mode the backend does not offer is not passed through', () => {
  // The modes belong to the backend: codex has no accept-edits, and asking for
  // one would be asking for something it cannot do.
  assert.equal(resolveMode(undefined, 'accept-edits', 'ask', [...CODEX]), 'ask')
  // Pi has one mode, so everything resolves to it.
  assert.equal(resolveMode('plan', 'ask', 'ask', [...PI]), 'auto')
})

const APP_MODEL = { modelID: 'gpt-5.6-sol', providerID: 'openai' }

test('a model the thread was set to in this window wins', () => {
  assert.deepEqual(
    resolveModel({ modelID: 'opus', providerID: 'anthropic' }, { modelID: 'sonnet', providerID: 'anthropic' }, APP_MODEL),
    { modelID: 'opus', providerID: 'anthropic' }
  )
})

test('a thread main knows the model of does not show the app default', () => {
  // An agent-created thread resolves its model in main and never passes through
  // renderer state. Falling through to the app default showed the model last
  // picked in some other thread instead of the one this thread runs on.
  assert.deepEqual(
    resolveModel(undefined, { modelID: 'opus', providerID: 'anthropic' }, APP_MODEL),
    { modelID: 'opus', providerID: 'anthropic' }
  )
})

test('a thread nobody has set a model for falls back to the app', () => {
  assert.deepEqual(resolveModel(undefined, undefined, APP_MODEL), APP_MODEL)
})

test('the provider follows the model that won', () => {
  // Pairing one source's provider with another's model names a model that
  // provider does not serve.
  assert.deepEqual(
    resolveModel(undefined, { modelID: 'opus', providerID: 'anthropic' }, { modelID: 'gpt-5.6-sol', providerID: 'openai' }),
    { modelID: 'opus', providerID: 'anthropic' }
  )
  // A local choice with no provider recorded keeps the app's rather than
  // borrowing main's, which belongs to a different model.
  assert.deepEqual(
    resolveModel({ modelID: 'opus' }, { modelID: 'sonnet', providerID: 'anthropic' }, { modelID: 'x', providerID: 'openai' }),
    { modelID: 'opus', providerID: 'openai' }
  )
})

test('a thinking level a thread chose wins', () => {
  assert.equal(resolveVariant(true, 'high', 'opus', { modelID: 'opus', providerID: 'anthropic', variant: 'low' }, null), 'high')
})

test('a thread set to no thinking stays that way', () => {
  // Explicitly none is a choice, not an absence — a truthy check would silently
  // replace it with the default.
  assert.equal(resolveVariant(true, null, 'opus', { modelID: 'opus', providerID: 'anthropic', variant: 'max' }, 'high'), null)
})

test('the default applies while the thread is on that model', () => {
  assert.equal(
    resolveVariant(false, null, 'opus', { modelID: 'opus', providerID: 'anthropic', variant: 'max' }, null),
    'max'
  )
})

test('the default does not follow the thread to another model', () => {
  // Sonnet stops at high where Opus goes to max, so carrying a level across
  // would ask for one the model does not have.
  assert.equal(
    resolveVariant(false, null, 'sonnet', { modelID: 'opus', providerID: 'anthropic', variant: 'max' }, null),
    null
  )
})

test('a backend with no default thinking uses the app default', () => {
  assert.equal(
    resolveVariant(false, null, 'opus', { modelID: 'opus', providerID: 'anthropic' }, 'medium'),
    'medium'
  )
})

test('a backend with no default model at all still resolves', () => {
  assert.equal(resolveVariant(false, null, undefined, undefined, 'low'), 'low')
  assert.equal(resolveMode(undefined, undefined, 'ask', [...CLAUDE]), 'ask')
})
