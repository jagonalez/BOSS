/** Which of a small set of colours names an agent in the transcript.
 *
 *  Roles are named by the user, so there is no fixed list to colour by hand.
 *  The name itself picks the colour, which means the same agent looks the same
 *  everywhere and in every session without anything being stored.
 *
 *  Four tones, not more: the point is to tell two speakers apart at a glance,
 *  and past four the colours stop being distinguishable anyway. */
const TONES = ['one', 'two', 'three', 'four'] as const

export type AuthorTone = typeof TONES[number]

export function authorTone(author: string): AuthorTone {
  // BOSS is the one name that is always the same agent, so it keeps one colour
  // rather than sharing whatever its letters happen to land on.
  if (author.toLowerCase() === 'boss') return 'one'
  let sum = 0
  for (let index = 0; index < author.length; index += 1) sum = (sum + author.charCodeAt(index)) % 997
  // BOSS holds the first tone, so everyone else draws from the rest.
  return TONES[1 + (sum % (TONES.length - 1))]
}

/** What a speaker is called, in the words the user gave it.
 *
 *  The transcript stores a role's id, which is how the app refers to it
 *  internally. Shown raw, an agent the user named "Reviewer" was labelled
 *  "reviewer", and BOSS came out in lower case.
 *
 *  Falls back to the id, because a role the user has since deleted still spoke:
 *  a message with no name at all would be worse than one named oddly. */
export function authorName(author: string, roles?: ReadonlyArray<{ id: string; label: string }>): string {
  const own = roles?.find((role) => role.id === author)?.label
  if (own) return own
  return author.toLowerCase() === 'boss' ? 'BOSS' : author
}
