import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * The summary form of thread.diff, which is what makes diffs viewable on a
 * phone at all.
 *
 * diffGet returns every changed file with its full contents. Ten edited files
 * of 50KB is about 1MB raw and ~1.3MB once sealed — well past the relay's
 * 512KB frame cap. And unlike a transcript, a diff cannot be trimmed to fit:
 * dropping entries from a list of changes hides them silently.
 *
 * So a remote client asks for a summary, then one path at a time. This pins the
 * shape of that contract; the manager does the same thing over real diffs.
 */
function summarize(diffs: Record<string, unknown>[]): Record<string, unknown>[] {
  return diffs.map(({ content: _c, original: _o, after: _a, before: _b, ...rest }) => rest)
}

// Ten files averaging 40KB of before-and-after text. Modest for an agent that
// has touched a feature across a codebase, and already past the frame cap.
const sample = Array.from({ length: 10 }, (_, i) => ({
  path: `src/file-${i}.ts`,
  additions: i + 1,
  deletions: i,
  content: 'x'.repeat(40_000),
  original: 'y'.repeat(40_000)
}))

test('a summary keeps what a list needs and drops what it does not', () => {
  const [first] = summarize(sample)
  assert.equal(first.path, 'src/file-0.ts')
  assert.equal(first.additions, 1)
  assert.equal(first.deletions, 0)
  assert.equal(first.content, undefined)
  assert.equal(first.original, undefined)
})

test('a summary lists every file, because dropping one would hide a change', () => {
  assert.equal(summarize(sample).length, sample.length)
})

test('the summary fits a relay frame where the full diff does not', () => {
  const RELAY_MAX_FRAME_BYTES = 512_000
  const sealed = (value: unknown): number => Math.ceil(Buffer.byteLength(JSON.stringify(value)) * 4 / 3)

  assert.ok(
    sealed(sample) > RELAY_MAX_FRAME_BYTES,
    'the full diff should exceed the cap, or this test proves nothing'
  )
  assert.ok(sealed(summarize(sample)) < RELAY_MAX_FRAME_BYTES)
})
