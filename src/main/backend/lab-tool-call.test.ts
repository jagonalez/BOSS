import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Application code uses bundler resolution.
import { parseToolArguments, ToolCallAccumulator } from './lab-tool-call.ts'

test('accumulates arguments across fragmented stream deltas', () => {
  const acc = new ToolCallAccumulator()
  acc.push({ index: 0, id: 'call_1', name: 'read_file', arguments: '{"path":' })
  acc.push({ index: 0, arguments: '"a.txt"' })
  acc.push({ index: 0, arguments: '}' })
  const calls = acc.calls()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].id, 'call_1')
  assert.equal(calls[0].name, 'read_file')
  assert.equal(calls[0].arguments, '{"path":"a.txt"}')
  assert.deepEqual(parseToolArguments(calls[0].arguments), { path: 'a.txt' })
})

test('orders multiple concurrent tool calls by index', () => {
  const acc = new ToolCallAccumulator()
  acc.push({ index: 1, id: 'call_b', name: 'bash', arguments: '{"command":"ls"}' })
  acc.push({ index: 0, id: 'call_a', name: 'write_file', arguments: '{"path":"x"}' })
  const calls = acc.calls()
  assert.deepEqual(calls.map((call) => call.id), ['call_a', 'call_b'])
})

test('a call missing its id still surfaces with name and arguments', () => {
  const acc = new ToolCallAccumulator()
  acc.push({ index: 0, arguments: '{"path":"y"}' })
  const calls = acc.calls()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].id, '')
  assert.equal(calls[0].name, '')
})

test('empty accumulator reports no calls', () => {
  const acc = new ToolCallAccumulator()
  assert.deepEqual(acc.calls(), [])
  assert.equal(acc.length, 0)
})

test('a call keeps its id and name when only later deltas repeat them', () => {
  const acc = new ToolCallAccumulator()
  acc.push({ index: 0, id: 'call_1', name: 'edit_file', arguments: '{"path":"p","old_string":"a' })
  acc.push({ index: 0, arguments: '"b"}' })
  acc.push({ index: 0, id: 'call_1' })
  const [call] = acc.calls()
  assert.equal(call.id, 'call_1')
  assert.equal(call.name, 'edit_file')
})

test('parseToolArguments returns {} for blank input', () => {
  assert.deepEqual(parseToolArguments(''), {})
  assert.deepEqual(parseToolArguments('   '), {})
})

test('parseToolArguments repairs a missing closing brace', () => {
  assert.deepEqual(parseToolArguments('{"path":"a.txt"'), { path: 'a.txt' })
})

test('parseToolArguments returns {} for JSON that parses to a primitive', () => {
  assert.deepEqual(parseToolArguments('"just a string"'), {})
  assert.deepEqual(parseToolArguments('42'), {})
})

test('parseToolArguments throws for unrepairable garbage', () => {
  assert.throws(() => parseToolArguments('{{{ not json'), /Could not parse tool arguments/)
})

test('a blank name in a later delta does not erase the name already seen', () => {
  const acc = new ToolCallAccumulator()
  acc.push({ index: 0, id: 'call_1', name: 'read_file', arguments: '' })
  acc.push({ index: 0, id: '', name: '', arguments: '{"path":' })
  acc.push({ index: 0, id: '', name: '', arguments: '"a.txt"}' })
  const [call] = acc.calls()
  assert.equal(call.id, 'call_1')
  assert.equal(call.name, 'read_file')
  assert.equal(call.arguments, '{"path":"a.txt"}')
})
