import type { JobNotes } from './room'

/** What a job agreed, decided, and changed, as a fresh agent will read it.
 *
 *  Shown to the user because this is a reviewer's whole brief: it reads these
 *  notes and nothing else. Anything missing here is missing from the review, so
 *  the user has to be able to see what it will be told.
 *
 *  Empty when there is nothing recorded, rather than a heading with nothing
 *  under it. */
export function briefOf(notes: JobNotes): string {
  const lines: string[] = []
  if (notes.agreed.length > 0) {
    lines.push('AGREED')
    for (const item of notes.agreed) lines.push(`· ${item}`)
  }
  if (notes.decided.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push('DECIDED')
    for (const item of notes.decided) lines.push(`· ${item.text} (${item.by})`)
  }
  if (notes.changed.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push('CHANGED')
    for (const item of notes.changed) lines.push(`· ${item}`)
  }
  return lines.join('\n')
}
