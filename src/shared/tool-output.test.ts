import assert from 'node:assert/strict'
import test from 'node:test'
// Node's type-stripping test runner requires explicit extensions.
// @ts-expect-error Application code uses bundler resolution.
import { trimToolOutput } from './tool-output.ts'

const message = (parts: unknown[]): { info: { id: string }; parts: unknown[] } =>
  ({ info: { id: 'm1' }, parts })

test('long tool output is shortened and its full length recorded', () => {
  const [out] = trimToolOutput([message([
    { type: 'tool', state: { status: 'completed', input: { command: 'ls' }, output: 'x'.repeat(100_000) } }
  ])] as never, 2_000) as never as Array<{ parts: Array<{ state: { output: string; outputTruncated: number } }> }>
  assert.equal(out.parts[0].state.output.length, 2_000)
  assert.equal(out.parts[0].state.outputTruncated, 100_000)
})

test('short output is left exactly as it was', () => {
  const parts = [{ type: 'tool', state: { output: 'ok' } }]
  const [out] = trimToolOutput([message(parts)] as never, 2_000) as never as Array<{ parts: unknown[] }>
  assert.deepEqual(out.parts[0], parts[0])
})

test('the input survives, because that is what a phone actually draws', () => {
  const [out] = trimToolOutput([message([
    { type: 'tool', state: { input: { command: 'npm test' }, output: 'y'.repeat(50_000) } }
  ])] as never, 100) as never as Array<{ parts: Array<{ state: { input: { command: string } } }> }>
  assert.equal(out.parts[0].state.input.command, 'npm test')
})

test('text and reasoning parts are untouched', () => {
  const parts = [
    { type: 'text', text: 'z'.repeat(10_000) },
    { type: 'reasoning', text: 'w'.repeat(10_000) }
  ]
  const [out] = trimToolOutput([message(parts)] as never, 100) as never as Array<{ parts: unknown[] }>
  assert.deepEqual(out.parts, parts)
})

test('a real Codex thread drops below the relay frame cap', () => {
  // 20 messages of 40 shell calls, each returning 100k characters: the shape
  // that arrived as one or two messages because the relay halved it away.
  const messages = Array.from({ length: 20 }, (_, i) => ({
    info: { id: `m${i}` },
    parts: Array.from({ length: 40 }, () => ({
      type: 'tool',
      state: { status: 'completed', input: { command: 'rg pattern' }, output: 'x'.repeat(100_000) }
    }))
  }))
  const before = Buffer.byteLength(JSON.stringify(messages))
  const after = Buffer.byteLength(JSON.stringify(trimToolOutput(messages as never, 2_000)))
  assert.ok(before > 512_000, 'the untrimmed payload should exceed the cap')
  assert.ok(after < before / 20, `expected a large reduction, got ${before} -> ${after}`)
})
