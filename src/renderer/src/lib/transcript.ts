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

  for (const message of messages) {
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
