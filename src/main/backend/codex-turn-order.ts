/** One contiguous piece of a Codex turn.
 *
 * Codex keeps steering input inside the turn already running. Its item list is
 * therefore user, work, user, work — not one user followed by one assistant.
 * Keeping that shape here prevents a history refresh from lifting every user
 * item above all of the work that preceded it. */
export type CodexTurnSlice<T> =
  | { role: 'user'; item: T; index: number }
  | { role: 'assistant'; items: T[]; index: number }

export function splitCodexTurnItems<T extends { type: string }>(items: T[]): CodexTurnSlice<T>[] {
  const slices: CodexTurnSlice<T>[] = []
  let assistantItems: T[] = []
  let lastUserIndex = -1
  let nextUserIndex = 0

  const flushAssistant = (): void => {
    if (!assistantItems.length) return
    slices.push({ role: 'assistant', items: assistantItems, index: lastUserIndex })
    assistantItems = []
  }

  for (const item of items) {
    if (item.type === 'hookPrompt') continue
    if (item.type === 'userMessage') {
      flushAssistant()
      lastUserIndex = nextUserIndex
      slices.push({ role: 'user', item, index: nextUserIndex })
      nextUserIndex += 1
    } else {
      assistantItems.push(item)
    }
  }
  flushAssistant()
  return slices
}
