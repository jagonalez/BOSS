import assert from 'node:assert/strict'
import test from 'node:test'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error Application code uses bundler resolution.
import { reportBodyFromAssistantText } from './report.ts'

test('a trailing automation summary is metadata rather than report content', () => {
  assert.equal(
    reportBodyFromAssistantText('## Changes\n\n- Added report history.\n\nSUMMARY: Added report history.'),
    '## Changes\n\n- Added report history.'
  )
})

test('summary-like content is preserved when it is not the final line', () => {
  assert.equal(
    reportBodyFromAssistantText('SUMMARY: Background\n\nThe detailed report follows.'),
    'SUMMARY: Background\n\nThe detailed report follows.'
  )
})

test('a summary-only answer still produces readable report content', () => {
  assert.equal(reportBodyFromAssistantText('SUMMARY: No changelog updates today.'), 'No changelog updates today.')
})
