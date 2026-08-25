import type { MessageWithParts, Part } from '../../../shared/opencode'

export interface TranscriptTurn {
  key: string
  user?: MessageWithParts
  assistants: MessageWithParts[]
}

export interface TranscriptSearchHit {
  turnKey: string
  messageId: string
}

function sameMessages(left: MessageWithParts[], right: MessageWithParts[]): boolean {
  return left.length === right.length && left.every((message, index) => message === right[index])
}

function turnKey(user: MessageWithParts | undefined, assistants: MessageWithParts[]): string {
  return `turn:${user?.info.id ?? assistants[0]?.info.id ?? 'empty'}`
}

function isLegacyToolImageMessage(message: MessageWithParts): boolean {
  return message.info.role === 'assistant'
    && message.info.id.startsWith('assistant-tool-image-')
    && message.parts.length > 0
    && message.parts.every((part) => part.type === 'file' && Boolean(part.state?.mime?.startsWith('image/') && part.state.url))
}

function imageSignature(part: Part): string | undefined {
  if (part.type !== 'file' || !part.state?.mime?.startsWith('image/')) return undefined
  return `${part.state.name ?? part.state.path ?? 'image'}\n${part.state.mime}`
}

/** Re-home screenshots written by BOSS versions that invented a standalone
 *  assistant message for an image before the backend reported its tool part.
 *
 *  Those messages have no real turn owner. While a response streams, grouping
 *  them with every successive assistant update makes the old screenshot look
 *  newly appended again and again. Attach their parts to the next real
 *  assistant message instead. If that message has not arrived yet, keep the
 *  image pending rather than rendering an ownerless tail. */
export function rehomeLegacyToolImages(messages: MessageWithParts[]): MessageWithParts[] {
  const normalized: MessageWithParts[] = []
  let pending: Part[] = []

  for (const message of messages) {
    if (isLegacyToolImageMessage(message)) {
      pending.push(...message.parts)
      continue
    }
    if (message.info.role === 'assistant' && pending.length > 0) {
      const owner = message.info.id
      // The fixed backend path may already have stored the same tool image on
      // its real assistant message. Match by tool name and MIME, with counts,
      // so one legacy/current pair collapses while two distinct screenshots
      // from the same tool still remain two.
      const ownedCounts = new Map<string, number>()
      for (const part of message.parts) {
        const signature = imageSignature(part)
        if (signature) ownedCounts.set(signature, (ownedCounts.get(signature) ?? 0) + 1)
      }
      const legacyParts = pending.filter((part) => {
        const signature = imageSignature(part)
        if (!signature) return true
        const owned = ownedCounts.get(signature) ?? 0
        if (owned === 0) return true
        ownedCounts.set(signature, owned - 1)
        return false
      })
      normalized.push({
        ...message,
        parts: [
          ...legacyParts.map((part) => ({ ...part, messageID: owner })),
          ...message.parts
        ]
      })
      pending = []
      continue
    }
    if (message.info.role === 'user') pending = []
    normalized.push(message)
  }

  return normalized
}

/**
 * Group messages into user/assistant turns while retaining unchanged group
 * objects. Store updates replace only the live message, so this lets memoized
 * historical turns stay asleep during streaming.
 */
export function groupTranscriptTurns(
  messages: MessageWithParts[],
  previous: TranscriptTurn[] = []
): TranscriptTurn[] {
  const next: TranscriptTurn[] = []
  const previousByKey = new Map(previous.map((turn) => [turn.key, turn]))
  let user: MessageWithParts | undefined
  let assistants: MessageWithParts[] = []

  const push = (): void => {
    if (!user && assistants.length === 0) return
    const key = turnKey(user, assistants)
    const old = previousByKey.get(key)
    next.push(old && old.user === user && sameMessages(old.assistants, assistants)
      ? old
      : { key, user, assistants })
  }

  for (const message of rehomeLegacyToolImages(messages)) {
    if (message.info.role === 'user') {
      push()
      user = message
      assistants = []
    } else {
      assistants.push(message)
    }
  }
  push()
  return next
}

function partSearchText(part: Part): string {
  const values: unknown[] = [
    part.text,
    part.state?.text,
    part.state?.content,
    part.state?.title,
    part.state?.tool,
    part.state?.name,
    part.state?.path,
    part.state?.output
  ]
  return values.map((value) => {
    if (typeof value === 'string') return value
    if (value === undefined || value === null) return ''
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }).join('\n')
}

/** Search the complete transcript model, including turns that are not mounted. */
export function searchTranscript(turns: TranscriptTurn[], query: string): TranscriptSearchHit[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return []
  const hits: TranscriptSearchHit[] = []
  for (const turn of turns) {
    const messages = turn.user ? [turn.user, ...turn.assistants] : turn.assistants
    for (const message of messages) {
      const text = message.parts.map(partSearchText).join('\n').toLocaleLowerCase()
      if (text.includes(needle)) hits.push({ turnKey: turn.key, messageId: message.info.id })
    }
  }
  return hits
}
