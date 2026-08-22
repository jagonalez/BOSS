/**
 * Draws the pending annotations onto the transcript.
 *
 * Without this the only sign a passage is attached is the pill above the
 * composer, which says what was quoted but not where it came from.
 *
 * Uses the CSS Custom Highlight API rather than wrapping the text in elements:
 * the transcript is React-owned, and injecting `<mark>` into it would be undone
 * on the next render and fight reconciliation in the meantime. Highlights live
 * beside the DOM instead, so the markup stays exactly as React wrote it.
 *
 * Ranges are rebuilt from character offsets on every relevant change rather
 * than held: React replaces text nodes freely, and a stored Range would end up
 * pointing at detached ones.
 */

import { useLayoutEffect } from 'react'
import { MESSAGE_ID_ATTR, MESSAGE_ROOT_SELECTOR, rangeFromAnchor } from '../lib/annotation-anchor'
import type { Annotation } from '@shared/annotations'

/** Matches the `::highlight()` rule in styles.css. */
const HIGHLIGHT_NAME = 'boss-annotation'

interface HighlightRegistry {
  set(name: string, highlight: unknown): void
  delete(name: string): void
}

function registry(): HighlightRegistry | undefined {
  return (CSS as unknown as { highlights?: HighlightRegistry }).highlights
}

export function AnnotationHighlights({
  annotations,
  scrollRef,
  // Changes whenever the transcript re-renders, which is what makes the
  // highlights follow their text as a reply streams in.
  revision
}: {
  annotations: readonly Annotation[]
  scrollRef: React.RefObject<HTMLElement>
  revision: unknown
}): null {
  useLayoutEffect(() => {
    const highlights = registry()
    if (!highlights) return
    const root = scrollRef.current
    // An older engine without the API simply shows no highlight; the pill above
    // the composer still reports what is attached.
    const Ctor = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight
    if (!root || !Ctor) return

    const ranges: Range[] = []
    for (const annotation of annotations) {
      const anchor = annotation.anchor
      if (!anchor) continue
      const message = root.querySelector<HTMLElement>(
        `${MESSAGE_ROOT_SELECTOR}[${MESSAGE_ID_ATTR}="${CSS.escape(anchor.messageId)}"]`
      )
      if (!message) continue
      const range = rangeFromAnchor(message, anchor)
      if (range) ranges.push(range)
    }

    if (ranges.length === 0) {
      highlights.delete(HIGHLIGHT_NAME)
      return
    }
    highlights.set(HIGHLIGHT_NAME, new Ctor(...ranges))
    return () => highlights.delete(HIGHLIGHT_NAME)
  }, [annotations, scrollRef, revision])

  return null
}
