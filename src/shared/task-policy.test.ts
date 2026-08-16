import assert from 'node:assert/strict'
import test from 'node:test'
// Node's type-stripping test runner requires explicit extensions.
// @ts-expect-error Application code uses bundler resolution.
import { budgetViolation, fallbackApplies, normalizeTaskPolicy, parseReviewVerdict } from './task-policy.ts'

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

test('fires the fallback only for the outcome it was configured for', () => {
  const on = (trigger: 'error' | 'interrupted' | 'either') =>
    ({ goal: '', budget: {}, reviewers: [], fallback: { backendId: 'claude' as const, trigger } })
  assert.equal(fallbackApplies(on('error'), 'error'), true)
  assert.equal(fallbackApplies(on('error'), 'interrupted'), false)
  assert.equal(fallbackApplies(on('interrupted'), 'interrupted'), true)
  assert.equal(fallbackApplies(on('either'), 'error'), true)
  assert.equal(fallbackApplies(on('either'), 'interrupted'), true)
  // A clean run never falls back, whatever the trigger.
  assert.equal(fallbackApplies(on('either'), 'completed'), false)
  assert.equal(fallbackApplies({ goal: '', budget: {}, reviewers: [] }, 'error'), false)
})

test('reads the reviewer verdict from its closing line', () => {
  assert.deepEqual(parseReviewVerdict('Looks good to me.\nPASS'), { verdict: 'pass', notes: [] })
  assert.deepEqual(
    parseReviewVerdict('CHANGES_REQUESTED\n- swallows the error\n- no test for the retry'),
    { verdict: 'changes-requested', notes: ['swallows the error', 'no test for the retry'] }
  )
})

test('prefers the reviewer\'s last verdict over an earlier mention', () => {
  const text = 'I will answer PASS or CHANGES_REQUESTED when done.\nChecked it.\nCHANGES_REQUESTED\n- missing bounds check'
  assert.deepEqual(parseReviewVerdict(text), {
    verdict: 'changes-requested',
    notes: ['missing bounds check']
  })
})

test('treats a reviewer that states no verdict as undecided, not a pass', () => {
  assert.equal(parseReviewVerdict('This mostly looks fine to me.'), undefined)
  assert.equal(parseReviewVerdict(''), undefined)
})
