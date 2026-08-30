import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Application code uses bundler resolution.
import { groupTranscriptTurns, rehomeLegacyToolImages, searchTranscript, insertionPoint } from './transcript.ts'
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

test('legacy standalone screenshots join the assistant message that produced them', () => {
  const user = message('user', 'user', 'inspect the page')
  const orphan = message('assistant-tool-image-old', 'assistant', '')
  orphan.parts = [{
    id: 'old-screenshot',
    type: 'file',
    sessionID: 'thread',
    messageID: orphan.info.id,
    state: { mime: 'image/png', name: 'boss_browser_screenshot', url: 'boss-image://thread/old.png' }
  }]
  const reply = message('reply', 'assistant', 'The layout is clipped.')

  const normalized = rehomeLegacyToolImages([user, orphan, reply])
  assert.deepEqual(normalized.map((item) => item.info.id), ['user', 'reply'])
  assert.deepEqual(normalized[1].parts.map((part) => ({ id: part.id, messageID: part.messageID })), [
    { id: 'old-screenshot', messageID: 'reply' },
    { id: 'reply-text', messageID: 'reply' }
  ])
})

test('a legacy screenshot waits for a real owner instead of becoming an open turn', () => {
  const orphan = message('assistant-tool-image-live', 'assistant', '')
  orphan.parts = [{
    id: 'live-screenshot',
    type: 'file',
    sessionID: 'thread',
    messageID: orphan.info.id,
    state: { mime: 'image/png', url: 'boss-image://thread/live.png' }
  }]

  assert.deepEqual(groupTranscriptTurns([message('user', 'user', 'look'), orphan]), [
    { key: 'turn:user', user: message('user', 'user', 'look'), assistants: [] }
  ])
})

test('a correctly owned screenshot replaces its legacy orphan copy', () => {
  const orphan = message('assistant-tool-image-old', 'assistant', '')
  orphan.parts = [{
    id: 'legacy-copy', type: 'file', sessionID: 'thread', messageID: orphan.info.id,
    state: { mime: 'image/png', name: 'boss_browser_screenshot', url: 'boss-image://thread/legacy.png' }
  }]
  const reply = message('reply', 'assistant', 'The page is visible.')
  reply.parts.unshift({
    id: 'owned-copy', type: 'file', sessionID: 'thread', messageID: reply.info.id,
    state: { mime: 'image/png', name: 'boss_browser_screenshot', url: 'boss-image://thread/owned.png' }
  })

  const normalized = rehomeLegacyToolImages([message('user', 'user', 'look'), orphan, reply])
  const images = normalized[1].parts.filter((part) => part.type === 'file')
  assert.deepEqual(images.map((part) => part.id), ['owned-copy'])
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

function authored(id: string, author: string, text: string): MessageWithParts {
  return {
    info: { id, role: 'assistant', sessionID: 'thread', author },
    parts: [{ id: `${id}-text`, type: 'text', sessionID: 'thread', messageID: id, text }]
  }
}

test('two agents replying in one turn stay separate, so they never speak with one voice', () => {
  const turns = groupTranscriptTurns([
    message('user-1', 'user', 'go through the review points'),
    authored('a-1', 'builder', 'I reverted the storage change.'),
    authored('a-2', 'reviewer', 'Confirmed against the diff.')
  ])

  assert.equal(turns.length, 2, 'the builder and the reviewer get a bubble each')
  assert.equal(turns[0].assistants[0].info.author, 'builder')
  assert.equal(turns[1].assistants[0].info.author, 'reviewer')
  assert.equal(turns[1].user, undefined, 'only the first turn owns the user message')
})

test('consecutive messages from one agent stay in one bubble', () => {
  const turns = groupTranscriptTurns([
    message('user-1', 'user', 'fix it'),
    authored('a-1', 'builder', 'Reproduced.'),
    authored('a-2', 'builder', 'Fixed.')
  ])

  assert.equal(turns.length, 1, 'one agent talking twice is still one voice')
  assert.equal(turns[0].assistants.length, 2)
})

test('a thread with a single unnamed agent groups exactly as it always did', () => {
  const turns = groupTranscriptTurns([
    message('user-1', 'user', 'hello'),
    message('a-1', 'assistant', 'thinking'),
    message('a-2', 'assistant', 'done')
  ])

  assert.equal(turns.length, 1, 'threads that never grew past one agent are untouched')
  assert.equal(turns[0].assistants.length, 2)
})

test('split turns keep distinct keys, so the virtual list can tell them apart', () => {
  const turns = groupTranscriptTurns([
    message('user-1', 'user', 'go'),
    authored('a-1', 'builder', 'one'),
    authored('a-2', 'reviewer', 'two')
  ])

  assert.notEqual(turns[0].key, turns[1].key)
})

/** Messages are placed by when they were made, not by when they arrived.
 *
 *  A backend can report its own reply before BOSS has recorded the message that
 *  caused it. Appending put the answer above the question, and nothing
 *  reordered it afterwards — so the conversation read backwards for good. */
function at(created?: number): MessageWithParts {
  return { info: { id: String(created ?? 'none'), sessionID: 's', role: 'user', ...(created === undefined ? {} : { time: { created } }) }, parts: [] }
}

test('a message made later goes last', () => {
  assert.equal(insertionPoint([at(1), at(2)], 3), 2)
})

test('a message made earlier goes before the one that overtook it', () => {
  // The fault seen in the app: the reply arrived first and the question landed
  // under it.
  assert.equal(insertionPoint([at(5)], 2), 0)
})

test('a message with no time is appended, because it cannot be placed', () => {
  // A part arriving before its message makes one of these. Guessing a position
  // would be worse than the order it came in.
  assert.equal(insertionPoint([at(1), at(2)], undefined), 2)
})

test('an existing message with no time stops the search', () => {
  // Nothing before it can be compared, so walking past it would be a guess.
  assert.equal(insertionPoint([at(9), at(undefined)], 1), 2)
})

test('an empty list takes the first message', () => {
  assert.equal(insertionPoint([], 7), 0)
})

test('equal times keep the order they arrived in', () => {
  // Two messages in the same millisecond are ordered by arrival, which is the
  // only information left.
  assert.equal(insertionPoint([at(4)], 4), 1)
})
