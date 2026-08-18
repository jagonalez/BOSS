import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error Application code uses bundler resolution.
import { hostPermissionResponse, resolveThreadMode } from './permission-mode.ts'
import type { BackendModeId } from './backend.ts'

const CLAUDE_MODES: BackendModeId[] = ['ask', 'auto', 'accept-edits', 'plan']

// Which backends run their own Auto policy. Mirrors DEFINITIONS in
// src/main/backend/manager.ts; the wiring test below checks they agree.
const NATIVE_AUTO = { claude: true, codex: true, pi: true, opencode: false }

test('Ask always prompts, whoever the backend is', () => {
  assert.equal(hostPermissionResponse('ask', true), undefined)
  assert.equal(hostPermissionResponse('ask', false), undefined)
})

test('Plan refuses, whoever the backend is', () => {
  // A read-only thread must not act, and a backend that asks anyway is asking
  // to do something Plan does not allow.
  assert.equal(hostPermissionResponse('plan', true), 'reject')
  assert.equal(hostPermissionResponse('plan', false), 'reject')
})

/** The regression this file exists for, part one.
 *
 *  claude and codex decide per tool which calls are safe and only ask about the
 *  ones they want confirmed. Answering those for them turns a graduated Auto
 *  into blanket approval — effectively bypassing permissions. */
test('Auto does not answer for a backend with its own policy', () => {
  assert.equal(hostPermissionResponse('auto', NATIVE_AUTO.claude), undefined)
  assert.equal(hostPermissionResponse('auto', NATIVE_AUTO.codex), undefined)
  assert.equal(hostPermissionResponse('auto', NATIVE_AUTO.pi), undefined)
})

test('Auto answers for a backend with no policy of its own', () => {
  // opencode has no internal Auto, so host approval is the only way Auto can
  // mean anything there.
  assert.equal(hostPermissionResponse('auto', NATIVE_AUTO.opencode), 'once')
})

test('accept-edits leaves the decision to the backend', () => {
  assert.equal(hostPermissionResponse('accept-edits', true), undefined)
  assert.equal(hostPermissionResponse('accept-edits', false), undefined)
})

/** The regression this file exists for, part two.
 *
 *  A thread holds one mode. Reading it per request is what makes a mid-run
 *  switch work, so the test changes the mode between two requests on the same
 *  thread and checks the second answer follows the new mode. */
test('a mode changed mid-run applies to the very next permission request', () => {
  const thread: { mode: BackendModeId } = { mode: 'ask' }
  // opencode, the backend BOSS answers for, so the change is visible here.
  const answer = (): 'once' | 'reject' | undefined =>
    hostPermissionResponse(resolveThreadMode(thread.mode, CLAUDE_MODES), false)

  assert.equal(answer(), undefined)

  thread.mode = 'auto'
  assert.equal(answer(), 'once', 'Ask to Auto must stop the prompts without a restart')

  // And back again, in the same run. A one-directional fix fails here.
  thread.mode = 'ask'
  assert.equal(answer(), undefined, 'Auto to Ask must start the prompts again')

  thread.mode = 'plan'
  assert.equal(answer(), 'reject', 'a switch to Plan must start refusing')
})

test('a stored mode the backend does not offer falls back to one it does', () => {
  // codex has no accept-edits. Left as-is it would decide nothing.
  assert.equal(resolveThreadMode('accept-edits', ['ask', 'auto', 'plan']), 'ask')
  assert.equal(resolveThreadMode(undefined, CLAUDE_MODES), 'ask')
  assert.equal(resolveThreadMode('auto', CLAUDE_MODES), 'auto')
  // pi offers only auto, so that is what a thread on it gets.
  assert.equal(resolveThreadMode('ask', ['auto']), 'auto')
})

/** Auto must not grant anything that outlives the mode. */
test('Auto allows one request at a time, never a lasting grant', () => {
  assert.notEqual(hostPermissionResponse('auto', false), 'always')
})

test('the manager reads the mode and the capability when the request arrives', () => {
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

  // The capability must reach the decision, or graduated Auto gets flattened.
  assert.ok(
    source.includes('DEFINITIONS[binding.backendId].capabilities.nativeAutoMode'),
    'the decision must know whether the backend has its own Auto policy'
  )
})

test('the capabilities in the manager match what this test assumes', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'main', 'backend', 'manager.ts'), 'utf8')
  for (const [backend, expected] of Object.entries(NATIVE_AUTO)) {
    const start = source.indexOf(`  ${backend}: {`)
    assert.ok(start > 0, `expected a definition for ${backend}`)
    const definition = source.slice(start, source.indexOf('modes:', start))
    assert.ok(
      definition.includes(`nativeAutoMode: ${expected}`),
      `${backend} should declare nativeAutoMode: ${expected}`
    )
  }
})

test('a running agent is told when the mode changes', () => {
  const manager = readFileSync(join(import.meta.dirname, '..', 'main', 'backend', 'manager.ts'), 'utf8')
  const setter = manager.slice(manager.indexOf('async setThreadMode('), manager.indexOf('private hostPermissionResponse('))
  // Only while it is running, and only through the backend's own hook.
  assert.ok(setter.includes('this.busyThreads.has(threadId)'), 'an idle thread has nothing to tell')
  assert.ok(setter.includes('permissionModeSet'), 'a running agent must be told directly')

  // claude takes the change on its own control call, so its Auto keeps
  // deciding rather than BOSS overriding it. The Agent SDK sends the
  // set_permission_mode request that BOSS used to write down the pipe.
  const claude = readFileSync(join(import.meta.dirname, '..', 'main', 'backend', 'claude-backend.ts'), 'utf8')
  assert.ok(claude.includes('query.setPermissionMode('), 'claude must be told through the run\'s own control call')

  // codex fixes its approval policy per turn, so it must report honestly that
  // the change waits rather than silently doing nothing.
  const codex = readFileSync(join(import.meta.dirname, '..', 'main', 'backend', 'codex-backend.ts'), 'utf8')
  const codexSetter = codex.slice(codex.indexOf('async permissionModeSet('))
  assert.ok(codexSetter.includes('!this.activeTurns.has(sessionId)'), 'codex must report a mid-turn change as pending')
})

test('the renderer tells main the moment the mode changes', () => {
  const actions = readFileSync(
    join(import.meta.dirname, '..', 'renderer', 'src', 'lib', 'actions.ts'),
    'utf8'
  )
  const setMode = actions.slice(actions.indexOf('export function setMode('), actions.indexOf('export async function setEngine('))
  assert.ok(setMode.includes('OpenCode.setThreadMode('), 'a mode change must reach main immediately')
  assert.ok(setMode.includes('pendingUntilNextMessage'), 'a change that has not taken effect must be surfaced')

  // The renderer must no longer answer permissions itself.
  const app = readFileSync(join(import.meta.dirname, '..', 'renderer', 'src', 'App.tsx'), 'utf8')
  assert.ok(!app.includes('autoRespond'), 'permission answers belong to main')
})
