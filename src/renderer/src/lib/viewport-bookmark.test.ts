import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Application code uses bundler resolution.
import { selectViewportAnchor, viewportAnchorScrollDelta } from './viewport-bookmark.ts'

test('a clipped virtual predecessor does not change the reading anchor', () => {
  const withoutPredecessor = selectViewportAnchor([
    { turnKey: 'turn-145', offsetFromViewportTop: 61 },
    { turnKey: 'turn-146', offsetFromViewportTop: 239 }
  ])
  const withPredecessor = selectViewportAnchor([
    { turnKey: 'turn-144', offsetFromViewportTop: -117 },
    { turnKey: 'turn-145', offsetFromViewportTop: 61 },
    { turnKey: 'turn-146', offsetFromViewportTop: 239 }
  ])

  assert.deepEqual(withoutPredecessor, { turnKey: 'turn-145', offsetFromViewportTop: 61 })
  assert.deepEqual(withPredecessor, withoutPredecessor)
})

test('the last clipped turn anchors a viewport below the final boundary', () => {
  assert.deepEqual(selectViewportAnchor([
    { turnKey: 'turn-318', offsetFromViewportTop: -240 },
    { turnKey: 'turn-319', offsetFromViewportTop: -62 }
  ]), { turnKey: 'turn-319', offsetFromViewportTop: -62 })
})

test('scroll correction restores the bookmarked boundary offset', () => {
  assert.equal(viewportAnchorScrollDelta(0, 61), -61)
  assert.equal(viewportAnchorScrollDelta(-93, -117), 24)
})
