import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Application code uses bundler resolution.
import { compactMeter, formatCompact, formatDuration, remainingTokens, usageDetailRows } from './token-meter.ts'
import type { ThreadUsageReport } from '../../../shared/supervision.ts'

function report(overrides: Partial<ThreadUsageReport> = {}): ThreadUsageReport {
  return {
    threadId: 't1',
    totals: { runs: 0, durationMs: 0, tokenRuns: 0, toolCalls: 0 },
    ...overrides
  }
}

test('formatCompact abbreviates like Command Center totals', () => {
  assert.equal(formatCompact(12_400), '12.4K')
})

test('formatDuration scales from seconds to hours', () => {
  assert.equal(formatDuration(500), '1s')
  assert.equal(formatDuration(45_000), '45s')
  assert.equal(formatDuration(95_000), '2m')
  assert.equal(formatDuration(5_400_000), '1h 30m')
})

test('a thread with nothing reported hides the meter entirely', () => {
  assert.equal(compactMeter(report()), null)
})

test('the meter shows what was reported, and only that', () => {
  assert.equal(compactMeter(report({ totals: { runs: 3, durationMs: 1_000, tokenRuns: 0, toolCalls: 4 } })), '3 runs')
  assert.equal(compactMeter(report({ totals: { runs: 0, durationMs: 0, tokens: 800, tokenRuns: 1, toolCalls: 0 } })), '800 tok')
  assert.equal(
    compactMeter(report({ totals: { runs: 4, durationMs: 9_000, tokens: 12_400, tokenRuns: 3, toolCalls: 11 } })),
    '12.4K tok · 4 runs'
  )
})

test('remaining budget appears on the meter only when a cap exists', () => {
  const spent = report({ totals: { runs: 2, durationMs: 0, tokens: 12_400, tokenRuns: 1, toolCalls: 0 } })
  assert.equal(compactMeter(spent), '12.4K tok · 2 runs')
  const capped = report({
    totals: { runs: 2, durationMs: 0, tokens: 12_400, tokenRuns: 1, toolCalls: 0 },
    budget: { maxTokens: 50_000 }
  })
  assert.equal(compactMeter(capped), '12.4K tok · 2 runs · 37.6K left')
})

test('overshooting the cap shows none left, never a negative allowance', () => {
  const over = report({
    totals: { runs: 2, durationMs: 0, tokens: 60_000, tokenRuns: 2, toolCalls: 0 },
    budget: { maxTokens: 50_000 }
  })
  assert.equal(remainingTokens(over), 0)
  assert.ok(compactMeter(over)!.endsWith('0 left'))
})

test('detail rows include every reported number and skip the absent ones', () => {
  const rows = usageDetailRows(report({
    totals: { runs: 4, durationMs: 95_000, tokens: 12_400, tokenRuns: 3, toolCalls: 11 },
    lastRun: { status: 'completed', startedAt: 1, finishedAt: 2, durationMs: 20_000, tokens: 3_100, toolCalls: 4 }
  }))
  assert.deepEqual(rows.map((row) => row.label), ['Reported tokens', 'Runs', 'Agent time', 'Tool calls', 'Last run'])
  assert.equal(rows[0].value, '12.4K across 3 runs')
  assert.equal(rows.at(-1)!.value, '3.1K tok · 20s · completed')
})

test('an empty thread produces no detail rows', () => {
  assert.deepEqual(usageDetailRows(report()), [])
})

test('budget rows show spend against the cap with what is left', () => {
  const rows = usageDetailRows(report({
    totals: { runs: 2, durationMs: 300_000, tokens: 12_400, tokenRuns: 1, toolCalls: 3 },
    budget: { maxTokens: 50_000, maxRuns: 10, maxDurationMinutes: 30 }
  }))
  const byLabel = new Map(rows.map((row) => [row.label, row.value]))
  assert.equal(byLabel.get('Token budget'), '12.4K of 50K · 37.6K left')
  assert.equal(byLabel.get('Run budget'), '2 of 10 · 8 left')
  assert.equal(byLabel.get('Time budget'), '5m of 30m')
})

test('a cap with nothing spent yet states the cap', () => {
  const rows = usageDetailRows(report({ budget: { maxTokens: 50_000, maxRuns: 5 } }))
  const byLabel = new Map(rows.map((row) => [row.label, row.value]))
  assert.equal(byLabel.get('Token budget'), 'cap 50K')
  assert.equal(byLabel.get('Run budget'), 'cap 5')
})
