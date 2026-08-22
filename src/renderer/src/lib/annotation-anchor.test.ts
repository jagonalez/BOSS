import assert from 'node:assert/strict'
import test from 'node:test'
// Node's type-stripping test runner requires explicit extensions.
// @ts-expect-error Application code uses bundler resolution.
import { resolveRuns } from './annotation-anchor.ts'

// A message renders as several text nodes — markdown turns `a **bold** word`
// into three. These lengths stand in for that split.
const RUNS = [5, 4, 6] // offsets 0-4, 5-8, 9-14

test('a selection inside one run resolves to that run', () => {
  assert.deepEqual(resolveRuns(RUNS, 1, 4), {
    start: { index: 0, offset: 1 },
    end: { index: 0, offset: 4 }
  })
})

test('a selection spanning runs keeps both ends in the right node', () => {
  assert.deepEqual(resolveRuns(RUNS, 2, 11), {
    start: { index: 0, offset: 2 },
    end: { index: 2, offset: 2 }
  })
})

test('a start on a run boundary binds to the following run, not the tail of the last', () => {
  // Offset 5 ends run 0 and begins run 1. Anchoring at the tail of run 0 would
  // draw a zero-width highlight on the element the selection does not cover.
  assert.deepEqual(resolveRuns(RUNS, 5, 7), {
    start: { index: 1, offset: 0 },
    end: { index: 1, offset: 2 }
  })
})

test('an end on a run boundary closes at the tail of the run it covers', () => {
  assert.deepEqual(resolveRuns(RUNS, 2, 5), {
    start: { index: 0, offset: 2 },
    end: { index: 0, offset: 5 }
  })
})

test('a selection covering everything resolves to the full span', () => {
  assert.deepEqual(resolveRuns(RUNS, 0, 15), {
    start: { index: 0, offset: 0 },
    end: { index: 2, offset: 6 }
  })
})

test('empty runs are skipped rather than hosting a position', () => {
  // React can leave zero-length text nodes between elements; a range starting
  // in one has nowhere to render.
  assert.deepEqual(resolveRuns([0, 0, 5], 0, 3), {
    start: { index: 2, offset: 0 },
    end: { index: 2, offset: 3 }
  })
})

test('an anchor past the end of the text does not resolve', () => {
  // The message was edited or is still streaming: better no highlight than one
  // on unrelated words.
  assert.equal(resolveRuns(RUNS, 12, 40), null)
})

test('an anchor entirely beyond the text does not resolve', () => {
  assert.equal(resolveRuns(RUNS, 90, 95), null)
})

test('a collapsed or inverted anchor does not resolve', () => {
  assert.equal(resolveRuns(RUNS, 4, 4), null)
  assert.equal(resolveRuns(RUNS, 6, 2), null)
})

test('a negative offset does not resolve', () => {
  assert.equal(resolveRuns(RUNS, -1, 3), null)
})

test('an empty message resolves nothing', () => {
  assert.equal(resolveRuns([], 0, 3), null)
})
