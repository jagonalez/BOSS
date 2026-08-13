import assert from 'node:assert/strict'
import test from 'node:test'
// Node's type-stripping test runner requires explicit extensions.
// @ts-expect-error Application code uses bundler resolution.
import { budgetViolation, normalizeTaskPolicy } from './task-policy.ts'

test('normalizes task policy bounds and preserves reviewer order', () => {
  const policy = normalizeTaskPolicy({
    goal: '  Ship safely  ',
    budget: { maxRuns: 2.8, maxTokens: -5, maxDurationMinutes: 1.5 },
    reviewers: [
      { backendId: 'codex', instruction: '  Review tests  ' },
      { backendId: 'claude' }
    ],
    fallback: { backendId: 'opencode', trigger: 'either' }
  })
  assert.equal(policy.goal, 'Ship safely')
  assert.deepEqual(policy.budget, { maxRuns: 2, maxTokens: undefined, maxDurationMinutes: 1.5 })
  assert.deepEqual(policy.reviewers, [
    { backendId: 'codex', instruction: 'Review tests' },
    { backendId: 'claude', instruction: undefined }
  ])
})

test('blocks the next run when any hard budget is exhausted', () => {
  const usage = { runs: 3, durationMs: 90_000, tokens: 5_000, tokenRuns: 3, toolCalls: 2 }
  assert.match(budgetViolation({ goal: '', budget: { maxRuns: 3 }, reviewers: [] }, usage) ?? '', /Run budget/)
  assert.match(budgetViolation({ goal: '', budget: { maxTokens: 5_000 }, reviewers: [] }, usage) ?? '', /token budget/)
  assert.match(budgetViolation({ goal: '', budget: { maxDurationMinutes: 1 }, reviewers: [] }, usage) ?? '', /Time budget/)
  assert.equal(budgetViolation({ goal: '', budget: { maxRuns: 4 }, reviewers: [] }, usage), undefined)
})
