/** What a paste into the terminal should actually send.
 *
 *  Separate from terminal-clipboard.ts, which reaches the clipboard and the
 *  confirm dialog. The rule below is the part worth testing, and keeping it
 *  free of the browser and the store is what makes that possible. */

/** Lines that, pasted whole, would run before you could read them. */
const MULTILINE_WARNING_THRESHOLD = 2

export interface PasteDecision {
  /** The text to send, which may differ from what was on the clipboard. */
  text: string
  /** Whether to ask first. */
  needsConfirm: boolean
  lineCount: number
}

/** Decide what to paste, and whether to ask first.
 *
 *  Copying a command out of a thread or a web page usually takes the line
 *  ending with it. Pasted as-is that newline submits the command immediately,
 *  which is both surprising and the mechanism behind clipboard-hijacking
 *  pages. Stripping it leaves the command at the prompt for you to read and
 *  press Enter yourself. Genuinely multi-line text still needs a question. */
export function normalizePaste(text: string): PasteDecision {
  const lines = text.split(/\r?\n/)
  if (lines.length === 1) return { text, needsConfirm: false, lineCount: 1 }
  if (lines.length === MULTILINE_WARNING_THRESHOLD && lines[1].trim() === '') {
    return { text: lines[0], needsConfirm: false, lineCount: 1 }
  }
  return { text, needsConfirm: true, lineCount: lines.length }
}
