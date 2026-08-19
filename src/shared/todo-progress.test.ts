import assert from 'node:assert/strict'
import test from 'node:test'
// Node's type-stripping test runner requires explicit extensions.
// @ts-expect-error Application code uses bundler resolution.
import { isCompletedTodoToolCall, partToolName } from './opencode.ts'
import type { Part } from './opencode.ts'

/** A todowrite part exactly as a real opencode server sends it.
 *
 *  Captured from scripts/probe-opencode-todos.mjs against the bundled binary.
 *  The detail that matters is where the name is: opencode sets the part's own
 *  `tool` field and leaves `state.tool` undefined, on every one of the 26 tool
 *  parts that run produced. */
function opencodeTodoPart(status: NonNullable<Part['state']>['status']): Part {
  return {
    id: 'prt_01594380b001w7DmBNLj6yrlu2',
    messageID: 'msg_015942f5a001iCfboMIJutxAPA',
    sessionID: 'ses_fea6be403ffeDYNWS9wq5LlHNn',
    type: 'tool',
    tool: 'todowrite',
    state: { status, input: {} }
  }
}

/** A tool part as claude, codex and pi build it: name inside the state. */
function handBuiltPart(tool: string): Part {
  return {
    id: 'prt_hand',
    messageID: 'msg_hand',
    sessionID: 'ses_hand',
    type: 'tool',
    state: { status: 'completed', tool }
  } as Part
}

test('a finished opencode todowrite is recognised as a todo write', () => {
  // The bug: this read only state.tool, which opencode never sets. The gate
  // matched nothing for the whole run, so the list was never re-read and the
  // indicator sat at the count it opened with — 0/x — until the run ended.
  assert.equal(isCompletedTodoToolCall(opencodeTodoPart('completed')), true)
})

test('the tool name is found wherever the backend put it', () => {
  assert.equal(partToolName(opencodeTodoPart('completed')), 'todowrite')
  assert.equal(partToolName(handBuiltPart('TodoWrite')), 'todowrite')
  assert.equal(partToolName({ state: { status: 'completed' } } as Part), '')
})

test('the backends that name the tool inside the state still match', () => {
  // Claude, codex and pi build their parts by hand and put the name in
  // state.tool. Reading the opencode spelling must not stop matching theirs.
  assert.equal(isCompletedTodoToolCall(handBuiltPart('TodoWrite')), true)
})

test('an unfinished todowrite does not trigger a read', () => {
  // The real run sends pending and running before completed for every call.
  // Reading the list then costs a request and shows the pre-write state.
  const unfinished: Array<NonNullable<Part['state']>['status']> = ['pending', 'running']
  for (const status of unfinished) {
    assert.equal(isCompletedTodoToolCall(opencodeTodoPart(status)), false, status)
  }
})

test('an ordinary tool call does not trigger a read', () => {
  // The same run made bash and read calls. Re-reading the todo list after each
  // would be a request per tool call for a list that did not change.
  const bash = { ...opencodeTodoPart('completed'), tool: 'bash' }
  assert.equal(isCompletedTodoToolCall(bash), false)
  assert.equal(isCompletedTodoToolCall({ ...opencodeTodoPart('completed'), type: 'text' } as Part), false)
})
