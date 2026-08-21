/**
 * Annotations let someone highlight a span of an assistant reply and attach a
 * note to it, so the next prompt can say "this part, specifically" instead of
 * re-describing the passage in prose.
 *
 * They are a composing-time affordance, not transcript metadata. An annotation
 * lives on the draft, is flattened into the outgoing prompt text by
 * `annotationsPrompt`, and is dropped once the message is sent. Nothing about a
 * sent message remembers where the highlight was.
 *
 * That is deliberate. The anchor is a pair of character offsets into the
 * *rendered* text of a message, which is only meaningful while the message is
 * on screen in its current form; a streaming reply re-renders and the offsets
 * stop pointing at the same words. Keeping anchors to the composing window
 * means the drift never has time to matter. `stripAnchors` enforces that at the
 * boundary so a stored annotation cannot carry a stale position.
 */

/**
 * Where a highlight sits, as character offsets into a message's rendered text.
 *
 * Offsets are over the text the reader actually sees (what `Range.toString()`
 * yields for the message element), not the markdown source, because the reader
 * selected rendered text and the source has syntax they never saw. `end` is
 * exclusive.
 */
export interface AnnotationAnchor {
  messageId: string
  start: number
  end: number
}

/** A quoted span with the reader's note on it. */
export interface Annotation {
  id: string
  /** The highlighted text, already clamped to `MAX_QUOTE_LENGTH`. */
  quote: string
  /** The reader's comment. Empty when the quote is a bare reference, which is
   *  how "add to side chat" hands a passage over with nothing to say yet. */
  note: string
  /** Present only while composing. Absent on anything sent or stored. */
  anchor?: AnnotationAnchor
}

/**
 * A select-all would otherwise paste an entire reply back into the prompt that
 * produced it, spending tokens to tell the model what it just said. Clamping at
 * creation keeps a mis-drag cheap, and the note still points at the right place
 * because the quote's opening words are what identify the passage.
 */
export const MAX_QUOTE_LENGTH = 2000

const PROMPT_HEADING =
  'Annotations on your earlier output (each quotes your words, then my note on them):'

/**
 * Trim a quote to the clamp, marking it so the model knows it was cut.
 *
 * Line breaks survive: a highlighted code block or list item means something
 * different once flattened onto one line, and the blockquote rendering in
 * `annotationsPrompt` relies on them. Only trailing whitespace per line and
 * blank edges are tidied, since a selection usually drags in leading indent
 * from the surrounding markup.
 */
export function clampQuote(text: string): string {
  const tidied = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim()
  if (tidied.length <= MAX_QUOTE_LENGTH) return tidied
  return `${tidied.slice(0, MAX_QUOTE_LENGTH).trimEnd()}…`
}

/**
 * True when a selection is worth offering the annotate affordance for.
 *
 * A collapsed range is a plain caret click, and a whitespace-only drag is
 * usually a mis-drag across a margin; neither is something to annotate.
 */
export function isAnnotatableSelection(text: string): boolean {
  return text.trim().length > 0
}

/** Build an annotation from a fresh selection. */
export function createAnnotation(
  id: string,
  quote: string,
  anchor: AnnotationAnchor,
  note = ''
): Annotation {
  return { id, quote: clampQuote(quote), note, anchor }
}

/**
 * Drop anchors from a set of annotations.
 *
 * Called at the send boundary. Once a message is on its way the offsets refer
 * to a rendering that is about to be superseded, so keeping them would only
 * preserve a position that no longer resolves.
 */
export function stripAnchors(annotations: readonly Annotation[]): Annotation[] {
  return annotations.map(({ id, quote, note }) => ({ id, quote, note }))
}

/**
 * Render annotations as the prefix of an outgoing prompt.
 *
 * Each quote becomes a blockquote so the model can tell its own returned words
 * from the reader's note on them, which a bare pair of paragraphs would blur.
 * Returns an empty string when there is nothing to say, so callers can
 * concatenate unconditionally.
 */
export function annotationsPrompt(annotations: readonly Annotation[]): string {
  const usable = annotations.filter((item) => item.quote.trim().length > 0)
  if (usable.length === 0) return ''

  const blocks = usable.map((item) => {
    const quoted = item.quote
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')
    const note = item.note.trim()
    return note ? `${quoted}\n\n${note}` : quoted
  })

  return `${PROMPT_HEADING}\n\n${blocks.join('\n\n')}`
}

/**
 * Combine annotations with whatever the reader typed.
 *
 * Annotations alone are a complete message: highlighting a passage and writing
 * a note beside it is a question, and forcing a separate sentence into the
 * composer to send it would be busywork.
 */
export function composeAnnotatedPrompt(
  annotations: readonly Annotation[],
  text: string
): string {
  const prefix = annotationsPrompt(annotations)
  const typed = text.trim()
  if (!prefix) return typed
  return typed ? `${prefix}\n\n${typed}` : prefix
}

/**
 * The opening line of a side chat started from a highlight.
 *
 * The side chat forks the parent thread, so the model already has the passage
 * in its context; this only points at which part is under discussion rather
 * than re-explaining it.
 */
export function sideChatSeedPrompt(annotation: Annotation): string {
  const quoted = annotation.quote
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
  const note = annotation.note.trim()
  return note
    ? `About this part of your earlier output:\n\n${quoted}\n\n${note}`
    : `Let's focus on this part of your earlier output:\n\n${quoted}`
}

/**
 * The annotations still pending after a send consumed some of them.
 *
 * A send awaits the backend, so a passage highlighted while it was in flight
 * belongs to the next prompt, not the one that just left. Filtering by the ids
 * actually composed keeps that highlight instead of clearing the thread's list
 * wholesale and discarding it unsent.
 */
export function remainingAnnotations(
  current: readonly Annotation[],
  consumedIds: readonly string[]
): Annotation[] {
  const consumed = new Set(consumedIds)
  return current.filter((item) => !consumed.has(item.id))
}
