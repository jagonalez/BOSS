import assert from 'node:assert/strict'
import test from 'node:test'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error TypeScript's bundler resolution omits it in application code.
import { claudeUsageWindows, codexUsageWindows } from './subscription-usage.ts'

test('normalizes Codex rate-limit windows and Unix-second resets', () => {
  assert.deepEqual(codexUsageWindows({
    rateLimits: {
      planType: 'plus',
      primary: { usedPercent: 35, windowDurationMins: 300, resetsAt: 1_800_000_000 },
      secondary: { usedPercent: 62, windowDurationMins: 10_080, resetsAt: 1_800_050_000 }
    }
  }), {
    plan: 'plus',
    windows: [
      { label: '5-hour limit', usedPercent: 35, resetsAt: 1_800_000_000_000 },
      { label: '7-day limit', usedPercent: 62, resetsAt: 1_800_050_000_000 }
    ]
  })
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
