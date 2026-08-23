/** Fuzzy subsequence scoring for the command palette.
 *
 *  A query matches when its characters appear in order anywhere in the text.
 *  The score prefers what a person meant: matches at the start of words and
 *  runs of adjacent characters outrank letters scattered through the string,
 *  and anything missing a character does not match at all. */

const SCORE_MATCH = 10
const SCORE_WORD_START = 8
const SCORE_ADJACENT = 6
const GAP_PENALTY = 2
const MAX_GAP_COST = 8

function isWordStart(text: string, index: number): boolean {
  if (index === 0) return true
  const previous = text[index - 1]
  if (/[\s\-_/·.]/.test(previous)) return true
  // A lower letter or digit followed by an upper one is a camel boundary.
  // Comparing the original casing here is why the caller passes both strings.
  return /[a-z0-9]/.test(previous) && /[A-Z]/.test(text[index])
}

/** Score `query` against `text`, or null when the text does not contain every
 *  query character in order. Case-insensitive; an empty query matches
 *  everything neutrally so the palette can list items before typing. */
export function fuzzyScore(query: string, text: string): number | null {
  const needle = query.toLocaleLowerCase()
  if (!needle) return 0
  const haystack = text.toLocaleLowerCase()
  let score = 0
  let from = 0
  for (let q = 0; q < needle.length; q++) {
    const char = needle[q]
    if (char === ' ') continue
    const found = haystack.indexOf(char, from)
    if (found < 0) return null
    score += SCORE_MATCH
    if (found === from && q > 0) score += SCORE_ADJACENT
    else score -= Math.min(found - from, MAX_GAP_COST) * GAP_PENALTY
    if (isWordStart(text, found)) score += SCORE_WORD_START
    from = found + 1
  }
  return score
}

/** The best score across several fields — a title plus its keywords, say — or
 *  null when no field matches. */
export function bestFuzzyScore(query: string, fields: string[]): number | null {
  let best: number | null = null
  for (const field of fields) {
    const score = fuzzyScore(query, field)
    if (score !== null && (best === null || score > best)) best = score
  }
  return best
}
