import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Application code uses bundler resolution.
import { compactionLabel } from './compaction.ts'

test('automatic compaction is named and includes token reduction when reported', () => {
  assert.equal(
    compactionLabel({
      auto: true,
      state: { metadata: { preTokens: 180_000, postTokens: 24_000 } }
    }),
    'Context compacted automatically — earlier messages were summarized. 180K → 24K tokens.'
  )
})

test('manual compaction does not claim it happened automatically', () => {
  assert.equal(compactionLabel({}), 'Context compacted — earlier messages were summarized.')
})

test('overflow warns about omission instead of claiming a summary exists', () => {
  assert.equal(
    compactionLabel({ auto: true, overflow: true }),
    'Earlier context was omitted to fit the model’s context window.'
  )
})
