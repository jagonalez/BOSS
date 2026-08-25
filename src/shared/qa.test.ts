import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Node's strip-types runner requires the TypeScript extension.
import { QA_TOOL_DEFINITIONS, shouldSurfaceToolImage } from './qa.ts'

test('computer inspection images stay internal unless explicitly surfaced', () => {
  assert.equal(shouldSurfaceToolImage('boss_computer', undefined), false)
  assert.equal(shouldSurfaceToolImage('boss_computer', { operation: 'get_window_state' }), false)
  assert.equal(shouldSurfaceToolImage('boss_computer', { showInTranscript: false }), false)
  assert.equal(shouldSurfaceToolImage('boss_computer', { showInTranscript: true }), true)
  assert.equal(shouldSurfaceToolImage('boss_computer', '{"showInTranscript":true}'), true)
  assert.equal(shouldSurfaceToolImage('boss_computer', 'not json'), false)
  assert.equal(shouldSurfaceToolImage('mcp__boss_thread_bus__boss_computer', { showInTranscript: true }), true)
  assert.equal(shouldSurfaceToolImage('boss_browser_screenshot', undefined), true)
})

test('the computer tool advertises the explicit transcript control', () => {
  const tool = QA_TOOL_DEFINITIONS.find((entry) => entry.name === 'boss_computer')
  const properties = tool?.inputSchema.properties as Record<string, unknown> | undefined
  assert.ok(properties?.showInTranscript)
  assert.match(tool?.description ?? '', /hidden from the transcript by default/)
})
