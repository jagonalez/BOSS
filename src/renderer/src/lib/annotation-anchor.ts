/**
 * Translating between a live DOM selection and the character offsets an
 * `AnnotationAnchor` stores.
 *
 * Offsets are counted over a message's *rendered* text — the string a reader
 * sees — rather than DOM node positions or markdown source. A DOM path breaks
 * the moment React re-renders the subtree and hands back different node
 * identities, and source offsets refer to syntax the reader never saw. Counting
 * rendered characters means the anchor stays meaningful as long as the words on
 * screen stay the same, which is exactly the window an annotation lives for.
 */

import type { AnnotationAnchor } from '@shared/annotations'

/** The transcript element a message's rendered text is measured against. */
export const MESSAGE_ROOT_SELECTOR = '.msg-body'

/** Marks the message a node belongs to, so a selection can be attributed. */
export const MESSAGE_ID_ATTR = 'data-message-id'

/**
 * How many rendered characters precede a point inside `root`.
 *
 * Uses a Range rather than walking text nodes so the count matches what the
 * reader selected: `Range.toString()` already applies the same rules the
 * browser used to build the selection.
 */
function offsetWithin(root: Node, node: Node, offset: number): number {
  const range = root.ownerDocument!.createRange()
  range.selectNodeContents(root)
  range.setEnd(node, offset)
  return range.toString().length
}

/** The message element a node sits inside, if any. */
export function messageRootOf(node: Node | null): HTMLElement | null {
  const start = node instanceof Element ? node : (node?.parentElement ?? null)
  return start?.closest<HTMLElement>(MESSAGE_ROOT_SELECTOR) ?? null
}

/**
 * Describe a selection as an anchor, or explain why it cannot be one.
 *
 * A selection that leaves a single message is rejected rather than clamped.
 * Spanning two messages would need a list of ranges and a quote that stitches
 * across a role boundary, and silently annotating only the first half would
 * attach the note to words the reader did not choose.
 */
export function anchorFromSelection(
  selection: Selection | null
): { anchor: AnnotationAnchor; quote: string; root: HTMLElement; range: Range } | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null

  const range = selection.getRangeAt(0)
  const root = messageRootOf(range.startContainer)
  if (!root) return null
  if (messageRootOf(range.endContainer) !== root) return null

  const messageId = root.getAttribute(MESSAGE_ID_ATTR)
  if (!messageId) return null

  const quote = range.toString()
  // A whitespace-only drag across a margin is not something to annotate. Kept
  // inline rather than shared: this module is unit-tested under Node's
  // type-stripping runner, which resolves no bundler aliases, so only erasable
  // `import type` may cross the @shared boundary here.
  if (!quote.trim()) return null

  const start = offsetWithin(root, range.startContainer, range.startOffset)
  return { anchor: { messageId, start, end: start + quote.length }, quote, root, range }
}

/** Which text run an offset lands in, and how far into it. */
export interface RunPosition {
  index: number
  offset: number
}

/**
 * Resolve start and end offsets against a sequence of text-run lengths.
 *
 * Split out from the DOM walk so the arithmetic — which is where the boundary
 * cases live — can be tested without a document.
 *
 * A boundary offset binds to the *start of the following run* rather than the
 * end of the preceding one. Both describe the same position in the text, but a
 * range beginning at the tail of a run it does not cover renders as a zero-width
 * artifact at the wrong element, so the later run is the one that draws
 * correctly. The end offset takes the opposite rule for the same reason: it
 * closes at the tail of the run it actually covers.
 */
export function resolveRuns(
  lengths: readonly number[],
  start: number,
  end: number
): { start: RunPosition; end: RunPosition } | null {
  if (start < 0 || end <= start) return null

  let consumed = 0
  let from: RunPosition | null = null

  for (let index = 0; index < lengths.length; index += 1) {
    const nodeEnd = consumed + lengths[index]

    // `start < nodeEnd` (not `<=`) pushes a boundary hit to the next run.
    // An empty run cannot host a position, so it never matches either.
    if (!from && start < nodeEnd) from = { index, offset: start - consumed }
    if (from && end <= nodeEnd) return { start: from, end: { index, offset: end - consumed } }

    consumed = nodeEnd
  }

  // The anchor runs past the end of the current text.
  return null
}

/**
 * Rebuild a DOM Range from stored offsets.
 *
 * Returns null when the text has changed enough that the offsets no longer fit,
 * which is the correct outcome: a highlight that cannot be placed should
 * disappear rather than land on unrelated words.
 */
export function rangeFromAnchor(root: HTMLElement, anchor: AnnotationAnchor): Range | null {
  const doc = root.ownerDocument!
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text)

  const resolved = resolveRuns(
    nodes.map((node) => node.textContent?.length ?? 0),
    anchor.start,
    anchor.end
  )
  if (!resolved) return null

  const range = doc.createRange()
  range.setStart(nodes[resolved.start.index], resolved.start.offset)
  range.setEnd(nodes[resolved.end.index], resolved.end.offset)
  return range
}

/**
 * Where to put the popover for a range: centred on the selection, at its top.
 *
 * Returns viewport coordinates because the popover is positioned fixed, which
 * keeps it aligned to the words while the transcript scrolls underneath.
 */
export function popoverAnchorPoint(range: Range): { x: number; y: number } | null {
  const rects = range.getClientRects()
  const rect = rects.length > 0 ? rects[0] : range.getBoundingClientRect()
  if (!rect || (rect.width === 0 && rect.height === 0)) return null
  return { x: rect.left + rect.width / 2, y: rect.top }
}
