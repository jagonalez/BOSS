import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Application code uses bundler resolution.
import { COMPUTER_USE_OPERATIONS, QA_TOOL_DEFINITIONS } from './qa.ts'

test('BOSS exposes CUA state capture instead of its removed screenshot operation', () => {
  assert.ok(COMPUTER_USE_OPERATIONS.includes('get_window_state'))
  assert.ok(COMPUTER_USE_OPERATIONS.includes('get_desktop_state'))
  assert.ok(!(COMPUTER_USE_OPERATIONS as readonly string[]).includes('screenshot'))

  const computer = QA_TOOL_DEFINITIONS.find((tool) => tool.name === 'boss_computer')
  const operation = (computer?.inputSchema.properties as Record<string, { enum?: string[] }> | undefined)?.operation
  assert.deepEqual(operation?.enum, [...COMPUTER_USE_OPERATIONS])
  assert.match(computer?.description ?? '', /return both state and a screenshot/)
})
