import assert from 'node:assert/strict'
import test from 'node:test'
// Node's type-stripping test runner requires explicit extensions.
// @ts-expect-error Application code uses bundler resolution.
import { extractSummary, lastAssistantText } from './thread-result.ts'
import type { MessageWithParts } from './opencode.ts'

function message(role: 'user' | 'assistant', ...texts: string[]): MessageWithParts {
  return {
    info: { id: role, sessionID: 's', role },
    parts: texts.map((text, index) => ({
      id: `${role}-${index}`,
      type: 'text' as const,
      sessionID: 's',
      messageID: role,
      text
    }))
  }
}

test('reads the most recent assistant reply, not the user turn', () => {
  const messages = [
    message('assistant', 'first reply'),
    message('user', 'a later question')
  ]
  assert.equal(lastAssistantText(messages), 'first reply')
})

test('joins every text part of the reply', () => {
  assert.equal(lastAssistantText([message('assistant', 'one', 'two')]), 'one\ntwo')
})

test('ignores parts that are not text', () => {
  const reply = message('assistant', 'visible')
  reply.parts.push({ id: 'tool', type: 'tool', sessionID: 's', messageID: 'assistant' })
  assert.equal(lastAssistantText([reply]), 'visible')
})

test('returns empty text when the thread has no assistant reply', () => {
  assert.equal(lastAssistantText([message('user', 'hello')]), '')
  assert.equal(lastAssistantText([]), '')
})

test('prefers an explicit SUMMARY line over the closing line', () => {
  const reply = message('assistant', 'SUMMARY: fixed the race\nSome trailing detail.')
  assert.equal(extractSummary([reply]), 'fixed the race')
})

test('falls back to the last non-empty line', () => {
  const reply = message('assistant', 'Looked at it.\n\nRenamed the flag.\n')
  assert.equal(extractSummary([reply]), 'Renamed the flag.')
})

test('has no summary when the thread produced no reply', () => {
  assert.equal(extractSummary([]), undefined)
})
