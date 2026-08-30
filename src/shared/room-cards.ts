/** A card an agent can put in a room, written as plain text.
 *
 *  Agents write text, so a card has to be something they can type. The fenced
 *  block below is the whole contract: a kind, a title, some lines, and at most
 *  two things the user can do. An agent that writes anything else still gets a
 *  readable message, because an unparseable block stays exactly as it was
 *  written rather than disappearing.
 *
 *      ```boss-card
 *      kind: gate
 *      title: Ready to ship
 *      Saved searches · 11 files changed
 *      ✓ 231 tests passed
 *      do: Ship it
 *      do: Hold
 *      ```
 */
export type CardKind =
  /** Something to approve before work goes further. */
  | 'gate'
  /** Something only the user can decide. */
  | 'attention'
  /** What is agreed, or what happened against it. */
  | 'plan'
  /** Anything else worth setting apart from the prose. */
  | 'note'

export interface RoomCard {
  kind: CardKind
  title: string
  /** Body lines, in the order written. A line beginning with a tick, a cross,
   *  or a circle renders as a marked row rather than a paragraph. */
  lines: string[]
  /** At most two. More than two turns a decision into a form, and the user was
   *  explicit that a card carries one way forward and one way out. */
  actions: string[]
  /** A thread this card points at, so BOSS can quote a room and let the user
   *  open it rather than describing where to look. */
  link?: { label: string; threadId: string }
}

const KINDS = new Set<string>(['gate', 'attention', 'plan', 'note'])

/** Read a card out of a fenced block, or return nothing.
 *
 *  Returning nothing is the important case: an agent that writes a malformed
 *  card must still be readable, so the caller leaves the text alone rather than
 *  swallowing it. */
export function parseCard(body: string): RoomCard | undefined {
  const lines = body.split('\n').map((line) => line.trim()).filter(Boolean)
  if (lines.length === 0) return undefined

  let kind: CardKind = 'note'
  let title = ''
  const rest: string[] = []
  const actions: string[] = []
  let link: RoomCard['link']

  for (const line of lines) {
    const [head, ...tail] = line.split(':')
    const value = tail.join(':').trim()
    const key = head.trim().toLowerCase()
    if (key === 'kind' && KINDS.has(value)) {
      kind = value as CardKind
      continue
    }
    if (key === 'title' && value) {
      title = value
      continue
    }
    if (key === 'do' && value) {
      // Capped rather than refused: a card with five buttons is still a card,
      // and dropping the whole thing over one extra would lose the message.
      if (actions.length < 2) actions.push(value)
      continue
    }
    if (key === 'open' && value) {
      const at = value.lastIndexOf('@')
      if (at > 0) link = { label: value.slice(0, at).trim(), threadId: value.slice(at + 1).trim() }
      continue
    }
    rest.push(line)
  }

  if (!title) return undefined
  return { kind, title, lines: rest, actions, ...(link ? { link } : {}) }
}

/** Split a message into prose and cards, keeping their order.
 *
 *  A card is a fenced block; everything else is text. Order matters because an
 *  agent explains a card before or after it, and reordering would separate the
 *  two. */
export interface CardSegment {
  type: 'text' | 'card'
  text?: string
  card?: RoomCard
}

const FENCE = /```boss-card\n([\s\S]*?)```/g

export function splitCards(text: string): CardSegment[] {
  const segments: CardSegment[] = []
  let last = 0
  for (const match of text.matchAll(FENCE)) {
    const card = parseCard(match[1])
    if (!card) continue
    const before = text.slice(last, match.index)
    if (before.trim()) segments.push({ type: 'text', text: before })
    segments.push({ type: 'card', card })
    last = (match.index ?? 0) + match[0].length
  }
  if (segments.length === 0) return [{ type: 'text', text }]
  const after = text.slice(last)
  if (after.trim()) segments.push({ type: 'text', text: after })
  return segments
}

/** How a body line renders: a marked row, or a paragraph. */
export function lineMark(line: string): { mark?: 'done' | 'gap' | 'waiting'; text: string } {
  if (line.startsWith('✓ ')) return { mark: 'done', text: line.slice(2) }
  if (line.startsWith('≠ ')) return { mark: 'gap', text: line.slice(2) }
  if (line.startsWith('○ ')) return { mark: 'waiting', text: line.slice(2) }
  return { text: line }
}
