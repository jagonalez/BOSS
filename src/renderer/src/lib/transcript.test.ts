import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Application code uses bundler resolution.
import { groupTranscriptTurns, searchTranscript } from './transcript.ts'
import type { MessageWithParts } from '../../../shared/opencode.ts'

function message(id: string, role: 'user' | 'assistant', text: string): MessageWithParts {
  return {
    info: { id, role, sessionID: 'thread' },
    parts: [{ id: `${id}-text`, type: 'text', sessionID: 'thread', messageID: id, text }]
  }
}

test('turn keys remain stable when earlier history is prepended', () => {
  const user = message('user-2', 'user', 'second')
  const assistant = message('assistant-2', 'assistant', 'reply')
  const before = groupTranscriptTurns([user, assistant])
  const after = groupTranscriptTurns([
    message('user-1', 'user', 'first'),
    message('assistant-1', 'assistant', 'reply'),
    user,
    assistant
  ], before)

  assert.equal(after[1].key, before[0].key)
  assert.equal(after[1], before[0])
})

test('only the streaming turn receives a new group object', () => {
  const firstUser = message('user-1', 'user', 'first')
  const firstAssistant = message('assistant-1', 'assistant', 'done')
  const liveUser = message('user-2', 'user', 'second')
  const liveAssistant = message('assistant-2', 'assistant', 'working')
  const before = groupTranscriptTurns([firstUser, firstAssistant, liveUser, liveAssistant])
  const updatedAssistant = message('assistant-2', 'assistant', 'working more')
  const after = groupTranscriptTurns([firstUser, firstAssistant, liveUser, updatedAssistant], before)

  assert.equal(after[0], before[0])
  assert.notEqual(after[1], before[1])
})

test('search finds messages in the complete transcript and tool output', () => {
  const old = message('old-user', 'user', 'needle in old history')
  const tool = message('tool-answer', 'assistant', '')
  tool.parts = [{
    id: 'tool-part', type: 'tool', sessionID: 'thread', messageID: 'tool-answer',
    state: { status: 'completed', title: 'Read output', output: { result: 'needle from tool' } }
  }]
  const toolPrompt = message('tool-user', 'user', 'inspect it')
  const turns = groupTranscriptTurns([old, message('old-answer', 'assistant', 'ok'), toolPrompt, tool])

  assert.deepEqual(searchTranscript(turns, 'NEEDLE'), [
    { turnKey: 'turn:old-user', messageId: 'old-user' },
    { turnKey: 'turn:tool-user', messageId: 'tool-answer' }
  ])
})
