import assert from 'node:assert/strict'
import test from 'node:test'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error TypeScript's bundler resolution omits it in application code.
import { claudeUsageWindows, codexUsageWindows, openCodeGoApiKeyFromAuth, openCodeGoUsageWindows } from './subscription-usage.ts'

test('normalizes Codex rate-limit windows and Unix-second resets', () => {
  assert.deepEqual(codexUsageWindows({
    rateLimits: {
      limitId: 'codex',
      planType: 'plus',
      primary: { usedPercent: 35, windowDurationMins: 300, resetsAt: 1_800_000_000 },
      secondary: { usedPercent: 62, windowDurationMins: 10_080, resetsAt: 1_800_050_000 }
    }
  }), {
    plan: 'plus',
    windows: [
      { group: 'Codex', label: '5-hour limit', usedPercent: 35, resetsAt: 1_800_000_000_000 },
      { group: 'Codex', label: '7-day limit', usedPercent: 62, resetsAt: 1_800_050_000_000 }
    ]
  })
})

test('keeps additional Codex model buckets separate from the shared pool', () => {
  assert.deepEqual(codexUsageWindows({
    rateLimits: {
      limitId: 'codex',
      primary: { usedPercent: 20, windowDurationMins: 300 }
    },
    rateLimitsByLimitId: {
      codex: { limitId: 'codex', primary: { usedPercent: 20, windowDurationMins: 300 } },
      spark: { limitId: 'spark', limitName: 'GPT-5.3-Codex-Spark', primary: { usedPercent: 4, windowDurationMins: 300 } }
    }
  }).windows, [
    { group: 'Codex', label: '5-hour limit', usedPercent: 20 },
    { group: 'GPT-5.3-Codex-Spark', label: '5-hour limit', usedPercent: 4 }
  ])
})

test('normalizes OpenCode Go rolling, weekly, and monthly limits', () => {
  const rollingReset = '2027-01-15T18:00:00.000Z'
  const weeklyReset = '2027-01-18T00:00:00.000Z'
  const monthlyReset = '2027-02-01T00:00:00.000Z'
  assert.deepEqual(openCodeGoUsageWindows({ usage: {
    rolling: { percent: 12, resetsAt: rollingReset },
    weekly: { percent: 34, resetsAt: weeklyReset },
    monthly: { percent: 56, resetsAt: monthlyReset }
  } }), [
    { label: '5-hour limit', usedPercent: 12, resetsAt: Date.parse(rollingReset) },
    { label: 'Weekly limit', usedPercent: 34, resetsAt: Date.parse(weeklyReset) },
    { label: 'Monthly limit', usedPercent: 56, resetsAt: Date.parse(monthlyReset) }
  ])
})

test('reads OpenCode Go credentials without confusing another provider key', () => {
  assert.equal(openCodeGoApiKeyFromAuth({
    anthropic: { type: 'api', key: 'wrong' },
    'opencode-go': { type: 'api', key: ' go-key ' },
    opencode: { type: 'api', key: 'zen-key' }
  }), 'go-key')
  assert.equal(openCodeGoApiKeyFromAuth({ opencode: { type: 'api', key: 'zen-key' } }), 'zen-key')
  assert.equal(openCodeGoApiKeyFromAuth({ 'opencode-go': { type: 'api' } }), undefined)
})

test('parses Claude provider quota wording without guessing its timezone', () => {
  assert.deepEqual(claudeUsageWindows([
    'You are currently using your subscription to power your Claude Code usage',
    'Current session: 8% used · resets Aug 22 at 12:50pm (America/Edmonton)',
    'Current week (all models): 29% used · resets Aug 26 at 6am (America/Edmonton)'
  ].join('\n')), [
    { label: 'Current session', usedPercent: 8, resetLabel: 'Aug 22 at 12:50pm (America/Edmonton)' },
    { label: 'Current week (all models)', usedPercent: 29, resetLabel: 'Aug 26 at 6am (America/Edmonton)' }
  ])
})
