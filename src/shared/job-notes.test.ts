import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Application code uses bundler resolution.
import { briefOf } from './job-notes.ts'

test('a brief holds what a job agreed, decided, and changed', () => {
  const brief = briefOf({
    agreed: ['inline warning, never an empty list'],
    decided: [{ text: 'index stays in the existing layer', at: 5, by: 'builder' }],
    changed: ['11 files, 3 new tests'],
    updatedAt: 9
  })
  assert.match(brief, /AGREED/)
  assert.match(brief, /inline warning, never an empty list/)
  assert.match(brief, /index stays in the existing layer \(builder\)/)
  assert.match(brief, /11 files, 3 new tests/)
})

test('a job with nothing recorded has an empty brief, not a bare heading', () => {
  // The user sees this text too, so an empty job must read as empty rather than
  // as three headings with nothing under them.
  assert.equal(briefOf({ agreed: [], decided: [], changed: [], updatedAt: 0 }), '')
})

test('a brief with only one kind of entry omits the other headings', () => {
  const brief = briefOf({ agreed: ['no cap on saved searches'], decided: [], changed: [], updatedAt: 1 })
  assert.match(brief, /AGREED/)
  assert.doesNotMatch(brief, /DECIDED/)
  assert.doesNotMatch(brief, /CHANGED/)
})
