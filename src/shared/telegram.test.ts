import assert from 'node:assert/strict'
import test from 'node:test'

// Node's type-stripping test runner requires explicit extensions.
// @ts-expect-error Application code uses bundler resolution.
import { formatTelegramFollowUp, parseTelegramUpdate, routeTelegramMessage, type TelegramMessage, type TelegramRoutingState } from './telegram.ts'

function textUpdate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    update_id: 101,
    message: {
      message_id: 7,
      from: { id: 5_000, first_name: 'Jeremy', last_name: 'Ash', username: 'jash' },
      chat: { id: 42, type: 'private', username: 'jash' },
      date: 1_800_000_000,
      text: '  check the failing CI run ',
      ...overrides
    },
    ...overrides
  }
}

function message(overrides: Partial<TelegramMessage> = {}): TelegramMessage {
  return { updateId: 1, messageId: 1, chatId: 42, chatTitle: '', senderName: 'Jeremy', text: 'hello', ...overrides }
}

const enabled = (overrides: Partial<TelegramRoutingState> = {}): TelegramRoutingState => ({
  enabled: true,
  threadId: 'thread-1',
  allowedChatIds: [],
  ...overrides
})

test('a text message parses into sender, chat, and trimmed text', () => {
  const parsed = parseTelegramUpdate(textUpdate())
  assert.ok(parsed)
  assert.equal(parsed.updateId, 101)
  assert.equal(parsed.messageId, 7)
  assert.equal(parsed.chatId, 42)
  assert.equal(parsed.senderName, 'Jeremy Ash')
  assert.equal(parsed.text, 'check the failing CI run')
})

test('edited messages, channel posts, and button presses are ignored', () => {
  assert.equal(parseTelegramUpdate({ update_id: 1, edited_message: textUpdate().message }), null)
  assert.equal(parseTelegramUpdate({ update_id: 1, channel_post: { message_id: 1, chat: { id: 2 }, text: 'x' } }), null)
  assert.equal(parseTelegramUpdate({ update_id: 1, callback_query: { id: 'q', data: 'y' } }), null)
})

test('updates without text, a chat, or an id parse to null', () => {
  assert.equal(parseTelegramUpdate({ message: textUpdate().message }), null)
  assert.equal(parseTelegramUpdate({ update_id: 1, message: { chat: { id: 2 }, text: '   ' } }), null)
  assert.equal(parseTelegramUpdate({ update_id: 1, message: { message_id: 3, text: 'no chat' } }), null)
  assert.equal(parseTelegramUpdate({ update_id: 1, message: { message_id: 3, chat: { id: 2 }, caption: 'photo only' } }), null)
  assert.equal(parseTelegramUpdate({}), null)
})

test('group messages carry the group title and fall back to @username for senders', () => {
  const parsed = parseTelegramUpdate(textUpdate({
    chat: { id: -100, type: 'group', title: 'Ops Room' },
    from: { id: 5_000, username: 'jash' }
  }))
  assert.ok(parsed)
  assert.equal(parsed.chatTitle, 'Ops Room')
  assert.equal(parsed.senderName, '@jash')
})

test('routing ignores disabled bots and missing targets before any pairing', () => {
  assert.deepEqual(routeTelegramMessage(enabled({ enabled: false }), message()), { decision: 'ignore', reason: 'disabled' })
  assert.deepEqual(routeTelegramMessage(enabled({ threadId: '' }), message()), { decision: 'ignore', reason: 'no-thread' })
})

test('an unknown chat is rejected while known chats pass', () => {
  const state = enabled({ allowedChatIds: [42] })
  assert.equal(routeTelegramMessage(state, message()).decision, 'queue')
  assert.equal(routeTelegramMessage(state, message({ chatId: 99 })).decision, 'ignore')
  assert.equal(routeTelegramMessage(state, message({ chatId: 99 })).reason, 'chat-not-allowed')
})

test('the first chat to write pairs automatically when none are known', () => {
  const result = routeTelegramMessage(enabled(), message({ chatId: 77 }))
  assert.equal(result.decision, 'queue')
  assert.equal(result.pairedChatId, 77)
})

test('a paired chat keeps working and stays distinct from the allowlist', () => {
  const state = enabled({ allowedChatIds: [], pairedChatId: 77 })
  assert.equal(routeTelegramMessage(state, message({ chatId: 77 })).decision, 'queue')
  assert.equal(routeTelegramMessage(state, message({ chatId: 88 })).decision, 'ignore')
})

test('follow-ups are prefixed so the thread knows where they came from', () => {
  assert.equal(formatTelegramFollowUp(message()), '[Telegram · Jeremy]\nhello')
  assert.equal(formatTelegramFollowUp(message({ senderName: '', chatTitle: 'Ops Room' })), '[Telegram · Ops Room]\nhello')
  assert.equal(formatTelegramFollowUp(message({ senderName: '', chatTitle: '' })), '[Telegram · chat 42]\nhello')
})
