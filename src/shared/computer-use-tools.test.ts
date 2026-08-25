import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Application code uses bundler resolution.
import { COMPUTER_USE_ACTION_OPERATIONS, COMPUTER_USE_INSPECTION_OPERATIONS, COMPUTER_USE_OPERATIONS, isComputerUseActionOperation, QA_TOOL_DEFINITIONS } from './qa.ts'

test('BOSS exposes the current scoped CUA desktop surface', () => {
  assert.ok(COMPUTER_USE_OPERATIONS.includes('get_window_state'))
  assert.ok(COMPUTER_USE_OPERATIONS.includes('get_desktop_state'))
  assert.ok(COMPUTER_USE_OPERATIONS.includes('bring_to_front'))
  assert.ok(COMPUTER_USE_OPERATIONS.includes('drag'))
  assert.ok(COMPUTER_USE_OPERATIONS.includes('invoke_menu'))
  assert.ok(COMPUTER_USE_OPERATIONS.includes('set_value'))
  assert.ok(!(COMPUTER_USE_OPERATIONS as readonly string[]).includes('screenshot'))
  assert.ok(!(COMPUTER_USE_OPERATIONS as readonly string[]).includes('wait'))
  assert.deepEqual(
    [...COMPUTER_USE_INSPECTION_OPERATIONS, ...COMPUTER_USE_ACTION_OPERATIONS],
    [...COMPUTER_USE_OPERATIONS]
  )

  const computer = QA_TOOL_DEFINITIONS.find((tool) => tool.name === 'boss_computer')
  const operation = (computer?.inputSchema.properties as Record<string, { enum?: string[] }> | undefined)?.operation
  assert.deepEqual(operation?.enum, [...COMPUTER_USE_OPERATIONS])
  assert.match(computer?.description ?? '', /return state plus a screenshot/)
  assert.match(computer?.description ?? '', /action \"show_menu\"/)
  assert.match(computer?.description ?? '', /bring_to_front/)
  assert.match(computer?.description ?? '', /element_token/)
})

test('every native-app mutation is classified as an Automatic QA action', () => {
  for (const operation of COMPUTER_USE_ACTION_OPERATIONS) {
    assert.equal(isComputerUseActionOperation(operation), true, operation)
  }
  for (const operation of COMPUTER_USE_INSPECTION_OPERATIONS) {
    assert.equal(isComputerUseActionOperation(operation), false, operation)
  }
  assert.equal(isComputerUseActionOperation('kill_app'), false)
})
