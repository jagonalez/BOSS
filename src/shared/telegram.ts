/**
 * Pure Telegram side of inbound messaging: turning a Bot API update into a
 * message BOSS can route, and deciding where it goes. The long-poll client in
 * main stays thin around these functions, and both are unit-tested without
 * touching the network.
 */

export interface TelegramMessage {
  /** Highest update id seen; the next getUpdates call passes offset = this + 1. */
  updateId: number
  messageId: number
  chatId: number
  chatTitle: string
  /** First + last name when available. */
  senderName: string
  text: string
}

export type TelegramUpdateInput = {
  update_id?: unknown
  message?: unknown
  edited_message?: unknown
  channel_post?: unknown
  callback_query?: unknown
} & Record<string, unknown>

/** Extract the newest relevant message from one update. Edited messages,
 *  channel posts, and button presses are ignored: BOSS reads new user texts
 *  only. Returns null for anything that is not a text message from a chat. */
export function parseTelegramUpdate(update: TelegramUpdateInput): TelegramMessage | null {
  if (typeof update.update_id !== 'number') return null
  const message = update.message
  if (typeof message !== 'object' || message === null) return null
  const record = message as Record<string, unknown>
  const messageId = record.message_id
  const chat = record.chat
  const from = record.from
  const text = record.text
  if (typeof messageId !== 'number') return null
  if (typeof chat !== 'object' || chat === null) return null
  if (typeof text !== 'string' || !text.trim()) return null
  const chatRecord = chat as Record<string, unknown>
  if (typeof chatRecord.id !== 'number') return null
  const fromRecord = (typeof from === 'object' && from !== null ? from : {}) as Record<string, unknown>
  const names = [fromRecord.first_name, fromRecord.last_name].filter((name): name is string => typeof name === 'string')
  const username = typeof fromRecord.username === 'string' ? `@${fromRecord.username}` : ''
  return {
    updateId: update.update_id,
    messageId,
    chatId: chatRecord.id,
    chatTitle: typeof chatRecord.title === 'string' ? chatRecord.title : typeof chatRecord.username === 'string' ? `@${chatRecord.username}` : '',
    senderName: names.join(' ') || username,
    text: text.trim()
  }
}

export type TelegramRouteDecision = 'steer' | 'queue' | 'ignore'

export interface TelegramRoutingState {
  enabled: boolean
  threadId: string
  /** Chats allowed to reach the thread. Empty means pair with the first chat that writes. */
  allowedChatIds: number[]
  pairedChatId?: number
}

export interface TelegramRoutingResult {
  decision: TelegramRouteDecision
  reason?: 'disabled' | 'no-thread' | 'chat-not-allowed'
  pairedChatId?: number
}

/** Decide what to do with an incoming message. A busy target thread gets the
 *  message steered into the active run; an idle one gets it queued (which
 *  delivers immediately). The first chat to write pairs automatically when no
 *  chats are known yet, mirroring how relay pairing works. */
export function routeTelegramMessage(state: TelegramRoutingState, message: TelegramMessage): TelegramRoutingResult {
  if (!state.enabled) return { decision: 'ignore', reason: 'disabled' }
  if (!state.threadId) return { decision: 'ignore', reason: 'no-thread' }
  let pairedChatId = state.pairedChatId
  const known = [...state.allowedChatIds, ...(pairedChatId !== undefined ? [pairedChatId] : [])]
  if (!known.includes(message.chatId)) {
    if (known.length > 0) return { decision: 'ignore', reason: 'chat-not-allowed' }
    pairedChatId = message.chatId
  }
  return { decision: 'queue', pairedChatId }
}

/** How a routed message is presented inside the thread. */
export function formatTelegramFollowUp(message: TelegramMessage): string {
  const who = message.senderName || message.chatTitle || `chat ${message.chatId}`
  return `[Telegram · ${who}]\n${message.text}`
}

export interface TelegramStatus {
  enabled: boolean
  /** True while the long-poll loop is live. */
  running: boolean
  error?: string
  /** Bot username, learned from getMe once polling succeeds. */
  username?: string
  /** Thread incoming messages are delivered to. */
  threadId: string
  allowedChatIds: number[]
  /** Chat that paired itself by writing first. */
  pairedChatId?: number
  tokenSet: boolean
  lastMessageAt?: number
}

export interface TelegramSettingsPatch {
  enabled?: boolean
  threadId?: string
  allowedChats?: number[]
  token?: string
  clearToken?: boolean
}
