import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Application code uses bundler resolution.
import { THREAD_TOOL_DEFINITIONS, isThreadTool } from './lab-thread-tools.ts'
// @ts-expect-error Application code uses bundler resolution.
import { ASSISTANT_TOOL_DEFINITIONS } from './lab-tools.ts'

test('the thread tools cover finding, reading, messaging, and handing off work', () => {
  const names = THREAD_TOOL_DEFINITIONS.map((tool) => tool.function.name)
  assert.deepEqual(names, [
    'boss_threads_list',
    'boss_threads_read',
    'boss_threads_send',
    'boss_threads_reply',
    'boss_threads_spawn_worktree'
  ])
  // Every definition carries a description: an undescribed tool goes unused.
  assert.ok(THREAD_TOOL_DEFINITIONS.every((tool) => tool.function.description.length > 40))
})

test('only the thread tools route to the bus', () => {
  assert.ok(isThreadTool('boss_threads_read'))
  assert.ok(isThreadTool('boss_threads_spawn_worktree'))
  assert.ok(!isThreadTool('not_a_thread_tool'))
  assert.ok(!isThreadTool('edit_file'))
})

test('the assistant is given the thread tools, so it can work across threads', () => {
  const assistant = ASSISTANT_TOOL_DEFINITIONS.map((tool) => tool.function.name)
  // The assistant delegates within a thread (spawn_subagent) and across
  // threads (spawn_worktree); the cross-thread half is what makes it a manager.
  assert.ok(assistant.includes('spawn_subagent'))
  assert.ok(!assistant.includes('edit_file'))
})
