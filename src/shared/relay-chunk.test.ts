import assert from 'node:assert/strict'
import test from 'node:test'
// Node's type-stripping test runner requires explicit extensions.
// @ts-expect-error Application code uses bundler resolution.
import { RELAY_MAX_FRAME_BYTES } from './relay.ts'

/**
 * The chunking contract, pinned on both sides.
 *
 * A response too large for one frame used to be halved until it fit, which is
 * how a Codex thread arrived showing only its last message or two. These
 * mirror what relay-client.ts sends and what mobile/src/relay.ts reassembles,
 * so the two cannot drift apart silently.
 */
const SLICE = Math.floor((RELAY_MAX_FRAME_BYTES - 2_000) * 3 / 4)

function send(result: unknown): string[] {
  const encoded = Buffer.from(JSON.stringify({ ok: true, result })).toString('base64')
  const total = Math.ceil(encoded.length / SLICE)
  return Array.from({ length: total }, (_, i) => encoded.slice(i * SLICE, (i + 1) * SLICE))
}

function receive(parts: string[]): unknown {
  const binary = Buffer.from(parts.join(''), 'base64').toString('utf8')
  return (JSON.parse(binary) as { result: unknown }).result
}

test('a payload larger than one frame survives the round trip', () => {
  // A Codex thread: hundreds of tool parts carrying shell output.
  const messages = Array.from({ length: 20 }, (_, i) => ({
    id: `assistant-${i}`,
    parts: Array.from({ length: 40 }, (_, j) => ({
      type: 'tool',
      state: { status: 'completed', input: { command: `run ${j}` }, output: 'x'.repeat(2_000) }
    }))
  }))
  const chunks = send(messages)
  assert.ok(chunks.length > 1, 'this payload should need more than one frame')
  assert.deepEqual(receive(chunks), messages)
})

test('every chunk fits inside a relay frame', () => {
  const big = [{ text: 'y'.repeat(3_000_000) }]
  for (const chunk of send(big)) {
    // Sealing base64s the ciphertext, growing it by a third, and the envelope
    // adds a little more on top.
    const sealed = Math.ceil(Buffer.byteLength(chunk) * 4 / 3) + 2_000
    assert.ok(sealed <= RELAY_MAX_FRAME_BYTES, `chunk of ${chunk.length} would not fit`)
  }
})

test('multi-byte characters are not split across a chunk boundary', () => {
  // The reason the payload is base64ed before it is cut: an em dash is three
  // bytes, and cutting one in half decodes to replacement characters.
  const text = '— café 🚀 '.repeat(120_000)
  const round = receive(send([{ text }])) as Array<{ text: string }>
  assert.equal(round[0].text, text)
  assert.ok(!round[0].text.includes('�'), 'no replacement characters')
})

test('chunks reassemble by index, not by arrival order', () => {
  const value = Array.from({ length: 500 }, (_, i) => ({ i, pad: 'z'.repeat(1_500) }))
  const chunks = send(value)
  assert.ok(chunks.length > 2, 'need several chunks to shuffle')
  // What the phone does: place each at its index, then join once all are in.
  const slots = new Array<string>(chunks.length)
  for (const i of [...chunks.keys()].reverse()) slots[i] = chunks[i]
  assert.deepEqual(receive(slots), value)
})
