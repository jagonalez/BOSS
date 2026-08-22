import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Application code uses bundler resolution.
import { parseSseEvents, SseDecoder } from './lab-sse.ts'

test('parses a single data event', () => {
  const events = parseSseEvents('data: hello\n\n')
  assert.deepEqual(events, [{ type: 'data', data: 'hello' }])
})

test('parses multiple events separated by blank lines', () => {
  const events = parseSseEvents('data: one\n\ndata: two\n\ndata: three\n\n')
  assert.deepEqual(events, [
    { type: 'data', data: 'one' },
    { type: 'data', data: 'two' },
    { type: 'data', data: 'three' }
  ])
})

test('joins multi-line data fields with newlines', () => {
  const events = parseSseEvents('data: line1\ndata: line2\n\n')
  assert.deepEqual(events, [{ type: 'data', data: 'line1\nline2' }])
})

test('emits done for the [DONE] sentinel', () => {
  const events = parseSseEvents('data: {"x":1}\n\ndata: [DONE]\n\n')
  assert.deepEqual(events, [
    { type: 'data', data: '{"x":1}' },
    { type: 'done' }
  ])
})

test('strips the optional leading space after the data: colon', () => {
  const events = parseSseEvents('data:spaced\n\ndata: {"a":1}\n\n')
  assert.deepEqual(events, [
    { type: 'data', data: 'spaced' },
    { type: 'data', data: '{"a":1}' }
  ])
})

test('ignores comment (keep-alive) lines', () => {
  const events = parseSseEvents(': ping\ndata: {"a":1}\n\n: still here\n')
  assert.deepEqual(events, [{ type: 'data', data: '{"a":1}' }])
})

test('treats CRLF line endings the same as LF', () => {
  const events = parseSseEvents('data: crlf\r\n\r\ndata: done\r\n\r\n')
  assert.deepEqual(events, [
    { type: 'data', data: 'crlf' },
    { type: 'data', data: 'done' }
  ])
})

test('decoder buffers partial events across chunks', () => {
  const decoder = new SseDecoder()
  assert.deepEqual(decoder.push('data: par'), [])
  assert.deepEqual(decoder.push('tial\n\ndata: nex'), [{ type: 'data', data: 'partial' }])
  assert.deepEqual(decoder.push('t\n\n'), [{ type: 'data', data: 'next' }])
  assert.deepEqual(decoder.push(''), [])
})

test('decoder handles a chunk containing several complete events', () => {
  const decoder = new SseDecoder()
  const events = decoder.push('data: a\n\ndata: b\n\ndata: [DONE]\n\n')
  assert.deepEqual(events, [
    { type: 'data', data: 'a' },
    { type: 'data', data: 'b' },
    { type: 'done' }
  ])
})

test('decoder flush returns nothing left over after a final blank line', () => {
  const decoder = new SseDecoder()
  decoder.push('data: final\n\n')
  assert.deepEqual(decoder.flush(), [])
})

test('a split [DONE] sentinel still decodes once assembled', () => {
  const decoder = new SseDecoder()
  assert.deepEqual(decoder.push('data: [DO'), [])
  const events = decoder.push('NE]\n\n')
  assert.deepEqual(events, [{ type: 'done' }])
  assert.deepEqual(decoder.flush(), [])
})

test('empty data events are skipped', () => {
  const events = parseSseEvents('data:\n\ndata: x\n\n')
  assert.deepEqual(events, [{ type: 'data', data: 'x' }])
})
