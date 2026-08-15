import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Application code uses bundler resolution.
import { groupPartRuns } from './part-runs.ts'
import type { Part } from '../../../shared/opencode.ts'

const tool = (id: string, input: Record<string, unknown>): Part => ({
  id,
  type: 'tool',
  sessionID: 's',
  messageID: 'm',
  state: { status: 'completed', input }
}) as Part

const command = (id: string): Part => tool(id, { command: 'ls' })
const edit = (id: string): Part => tool(id, { file_path: '/src/a.ts' })
const reasoning = (id: string, text: string): Part => ({
  id, type: 'reasoning', sessionID: 's', messageID: 'm', text
}) as Part

test('neighbouring calls of one kind become a run', () => {
  const runs = groupPartRuns([command('1'), command('2'), command('3')])
  assert.equal(runs.length, 1)
  assert.equal(runs[0].kind, 'command')
  assert.equal(runs[0].parts.length, 3)
})

test('a different kind starts a new run', () => {
  const runs = groupPartRuns([command('1'), edit('2'), command('3')])
  assert.deepEqual(runs.map((run) => run.kind), ['command', 'edit', 'command'])
  assert.deepEqual(runs.map((run) => run.parts.length), [1, 1, 1])
})

test('reasoning is never folded into a run', () => {
  // It explains the calls around it. Hiding it behind a count would bury the
  // one part written to be read.
  const runs = groupPartRuns([reasoning('1', 'first'), reasoning('2', 'second')])
  assert.equal(runs.length, 2)
  assert.deepEqual(runs.map((run) => run.kind), ['reasoning', 'reasoning'])
})

test('reasoning between calls breaks the run around it', () => {
  const runs = groupPartRuns([command('1'), reasoning('2', 'why'), command('3')])
  assert.deepEqual(runs.map((run) => run.kind), ['command', 'reasoning', 'command'])
})

test('empty reasoning and other part types are left out', () => {
  const text = { id: 't', type: 'text', sessionID: 's', messageID: 'm', text: 'hello' } as Part
  const runs = groupPartRuns([text, reasoning('1', '   '), command('2')])
  assert.deepEqual(runs.map((run) => run.kind), ['command'])
})

test('each part keeps its position in the message', () => {
  // The index disambiguates keys: Claude emits tool_use and tool_result as
  // separate parts sharing one id.
  const runs = groupPartRuns([reasoning('a', 'why'), command('b'), command('b')])
  assert.deepEqual(runs[1].parts.map((entry) => entry.index), [1, 2])
})

test('a long task collapses to a handful of rows', () => {
  // The reported case: forty-five commands in one flat wall.
  const parts = Array.from({ length: 45 }, (_, index) => command(String(index)))
  const runs = groupPartRuns(parts)
  assert.equal(runs.length, 1, '45 commands should be one run, not 45 rows')
  assert.equal(runs[0].parts.length, 45)
})
