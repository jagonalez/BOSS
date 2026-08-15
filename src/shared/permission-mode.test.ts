import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error Application code uses bundler resolution.
import { hostPermissionResponse, resolveThreadMode } from './permission-mode.ts'
import type { BackendModeId } from './backend.ts'

const CLAUDE_MODES: BackendModeId[] = ['ask', 'auto', 'accept-edits', 'plan']

test('Ask prompts the user, Auto answers, Plan refuses', () => {
  assert.equal(hostPermissionResponse('ask'), undefined)
  assert.equal(hostPermissionResponse('auto'), 'once')
  assert.equal(hostPermissionResponse('plan'), 'reject')
  // accept-edits leaves the decision to the backend's own edit policy.
  assert.equal(hostPermissionResponse('accept-edits'), undefined)
})

/** The bug this file exists for.
 *
 *  A thread holds one mode. Reading it per request is what makes a mid-run
 *  switch work, so the test changes the mode between two requests on the same
 *  thread and checks that the second answer follows the new mode. */
test('a mode changed mid-run applies to the very next permission request', () => {
  const thread: { mode: BackendModeId } = { mode: 'ask' }
  const answer = (): 'once' | 'reject' | undefined =>
    hostPermissionResponse(resolveThreadMode(thread.mode, CLAUDE_MODES))

  // Ask: the first request reaches the user.
  assert.equal(answer(), undefined)

  // The user switches to Auto while the run is still going.
  thread.mode = 'auto'
  assert.equal(answer(), 'once', 'Ask to Auto must stop the prompts without a restart')

  // And back again, in the same run. A one-directional fix passes the line
  // above and fails this one.
  thread.mode = 'ask'
  assert.equal(answer(), undefined, 'Auto to Ask must start the prompts again')
})

test('a stored mode the backend does not offer falls back to one it does', () => {
  // codex has no accept-edits. Left as-is it would decide nothing.
  assert.equal(resolveThreadMode('accept-edits', ['ask', 'auto', 'plan']), 'ask')
  assert.equal(resolveThreadMode(undefined, CLAUDE_MODES), 'ask')
  assert.equal(resolveThreadMode('auto', CLAUDE_MODES), 'auto')
  // pi offers only auto, so that is what a thread on it gets.
  assert.equal(resolveThreadMode('ask', ['auto']), 'auto')
})

/** Auto must not grant anything that outlives the mode.
 *
 *  Answering 'always' would leave a permission granted after a switch back to
 *  Ask, which is the same class of stale state as the launch flag. */
test('Auto allows one request at a time, never a lasting grant', () => {
  assert.notEqual(hostPermissionResponse('auto'), 'always')
})

/** The manager must read the mode when the request arrives.
 *
 *  The decision itself is covered above; what this guards is the wiring. An
 *  earlier fix answered permissions in the renderer and skipped any backend
 *  claiming nativeAutoMode, so claude never got a host answer at all. */
test('the manager answers permission requests from the thread binding', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'main', 'backend', 'manager.ts'), 'utf8')

  const handler = source.slice(
    source.indexOf("eventType === 'permission.asked'"),
    source.indexOf("eventType === 'permission.replied'")
  )
  assert.ok(handler.includes('this.hostPermissionResponse(binding)'), 'the answer must come from the binding')

  // Read per request. A snapshot taken at spawn is the original bug.
  assert.ok(
    source.includes('return resolveThreadMode(binding.mode, DEFINITIONS[binding.backendId].modes.map((mode) => mode.id))'),
    'the mode must be read from the binding, not captured'
  )

  // nativeAutoMode stays a declared capability, but it must not gate whether
  // BOSS enforces the mode: that gate is what let claude keep prompting.
  assert.ok(!handler.includes('nativeAutoMode'), 'capability flags must not gate mode enforcement')

  // The decision comes from the shared module, so there is one rule.
  assert.ok(
    source.includes("from '@shared/permission-mode'"),
    'the manager must use the shared decision, not its own copy'
  )
})

test('the renderer tells main the moment the mode changes', () => {
  const actions = readFileSync(
    join(import.meta.dirname, '..', 'renderer', 'src', 'lib', 'actions.ts'),
    'utf8'
  )
  const setMode = actions.slice(actions.indexOf('export function setMode('), actions.indexOf('export async function setEngine('))
  assert.ok(setMode.includes('OpenCode.setThreadMode('), 'a mode change must reach main immediately')

  // The renderer must no longer answer permissions itself.
  const app = readFileSync(join(import.meta.dirname, '..', 'renderer', 'src', 'App.tsx'), 'utf8')
  assert.ok(!app.includes('autoRespond'), 'permission answers belong to main')
})
