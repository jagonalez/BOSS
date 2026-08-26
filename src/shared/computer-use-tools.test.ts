import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
// @ts-expect-error Application code uses bundler resolution.
import { COMPUTER_USE_ACTION_OPERATIONS, COMPUTER_USE_INSPECTION_OPERATIONS, COMPUTER_USE_OPERATIONS, isComputerUseActionOperation, normalizeComputerUseArguments, QA_TOOL_DEFINITIONS } from './qa.ts'

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
  assert.match(computer?.description ?? '', /translated to the driver action \"show_menu\"/)
  assert.match(computer?.description ?? '', /bring_to_front/)
  assert.match(computer?.description ?? '', /element_token/)
  assert.match(computer?.description ?? '', /never apply display scale or window offsets/)

  const args = (computer?.inputSchema.properties as Record<string, { properties?: Record<string, unknown> }> | undefined)?.arguments
  assert.ok(args?.properties?.action)
  assert.ok(args?.properties?.delivery_mode)
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

test('accessibility-tree action spellings are canonicalized without changing targeting', () => {
  const advertised = {
    pid: 4242,
    window_id: 73,
    element_token: 'snapshot:9',
    action: 'showmenu',
    delivery_mode: 'foreground'
  }
  assert.deepEqual(normalizeComputerUseArguments('click', advertised), {
    ...advertised,
    action: 'show_menu'
  })
  assert.deepEqual(normalizeComputerUseArguments('click', { action: 'AXShowMenu' }), { action: 'show_menu' })
  assert.deepEqual(normalizeComputerUseArguments('click', { action: 'right-click' }), { action: 'show_menu' })

  const canonical = { action: 'show_menu' }
  assert.equal(normalizeComputerUseArguments('click', canonical), canonical)
  assert.equal(normalizeComputerUseArguments('scroll', advertised), advertised)

  const pixels = { pid: 4242, window_id: 73, x: -80.5, y: 1440.25 }
  assert.equal(normalizeComputerUseArguments('click', pixels), pixels)
})

test('unknown click actions fail closed instead of becoming an AXPress', () => {
  assert.throws(
    () => normalizeComputerUseArguments('click', { action: 'show-menu-typo' }),
    /not supported.*show_menu/
  )
})

test('BOSS bundles the driver release with foreground focus verification', () => {
  const script = readFileSync(join(import.meta.dirname, '..', '..', 'scripts', 'fetch-cua-driver.sh'), 'utf8')
  assert.match(script, /CUA_DRIVER_VERSION:-0\.20\.0/)
})
