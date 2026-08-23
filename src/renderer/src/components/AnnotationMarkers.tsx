/**
 * The numbered handles that make a placed annotation reachable again.
 *
 * Without these, a highlight is a dead end: the colour says a note is attached
 * but there is no way back to it, so revising a note means removing the pill
 * above the composer and re-selecting the same words. A marker sits at the tail
 * of each highlight and reopens the note editor on the passage it belongs to.
 *
 * Positions are measured from live ranges rather than stored, for the reason
 * `AnnotationHighlights` rebuilds its ranges: React replaces text nodes freely,
 * so anything held from a previous render points at detached ones. The measure
 * re-runs whenever the transcript re-renders or scrolls.
 *
 * Coordinates are viewport-relative and the markers are `position: fixed`, the
 * same choice `popoverAnchorPoint` makes — the transcript is the scrolling
 * element, so a fixed marker tracks its words without needing the container to
 * become a containing block.
 */

import React, { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { MESSAGE_ID_ATTR, MESSAGE_ROOT_SELECTOR, rangeFromAnchor } from '../lib/annotation-anchor'
import type { Annotation } from '@shared/annotations'

export interface MarkerPlacement {
  id: string
  number: number
  x: number
  y: number
}

/** Where each annotation's marker belongs, in viewport coordinates. */
function placeMarkers(root: HTMLElement, annotations: readonly Annotation[]): MarkerPlacement[] {
  const placed: MarkerPlacement[] = []
  annotations.forEach((annotation, index) => {
    const anchor = annotation.anchor
    if (!anchor) return
    const message = root.querySelector<HTMLElement>(
      `${MESSAGE_ROOT_SELECTOR}[${MESSAGE_ID_ATTR}="${CSS.escape(anchor.messageId)}"]`
    )
    if (!message) return
    const range = rangeFromAnchor(message, anchor)
    if (!range) return
    // The last client rect, not the bounding box: a highlight wrapping several
    // lines has a bounding box whose right edge is the column edge, which would
    // strand the marker far past where the words actually stop.
    const rects = range.getClientRects()
    const tail = rects[rects.length - 1] ?? range.getBoundingClientRect()
    // A range that has been scrolled out of the transcript still reports a rect;
    // clipping here keeps markers from piling up over the composer and header.
    const bounds = root.getBoundingClientRect()
    if (tail.bottom < bounds.top || tail.top > bounds.bottom) return
    placed.push({ id: annotation.id, number: index + 1, x: tail.right, y: tail.top })
  })
  return placed
}

/** Placements are recomputed far more often than they move. */
function same(a: readonly MarkerPlacement[], b: readonly MarkerPlacement[]): boolean {
  return (
    a.length === b.length &&
    a.every((marker, index) => {
      const next = b[index]
      return (
        marker.id === next.id &&
        marker.number === next.number &&
        marker.x === next.x &&
        marker.y === next.y
      )
    })
  )
}

export function AnnotationMarkers({
  annotations,
  scrollRef,
  revision,
  onEdit
}: {
  annotations: readonly Annotation[]
  scrollRef: React.RefObject<HTMLElement>
  /** Changes when the transcript re-renders, so markers follow streaming text. */
  revision: unknown
  onEdit: (annotation: Annotation, at: { x: number; y: number }) => void
}): React.JSX.Element | null {
  const [markers, setMarkers] = useState<MarkerPlacement[]>([])

  const measure = useCallback((): void => {
    const root = scrollRef.current
    if (!root) {
      setMarkers((current) => (current.length ? [] : current))
      return
    }
    const placed = placeMarkers(root, annotations)
    setMarkers((current) => (same(current, placed) ? current : placed))
  }, [annotations, scrollRef])

  useLayoutEffect(measure, [measure, revision])

  // Markers are fixed to the viewport, so they do not move with their words on
  // their own — the transcript scrolling under them is exactly when they must be
  // re-measured.
  useEffect(() => {
    const root = scrollRef.current
    if (!root) return
    root.addEventListener('scroll', measure, { passive: true })
    window.addEventListener('resize', measure)
    return () => {
      root.removeEventListener('scroll', measure)
      window.removeEventListener('resize', measure)
    }
  }, [measure, scrollRef])

  if (markers.length === 0) return null

  return createPortal(
    <>
      {markers.map((marker) => (
        <button
          key={marker.id}
          type="button"
          className="annotation-marker"
          style={{ left: marker.x, top: marker.y }}
          aria-label={`Edit annotation ${marker.number}`}
          title="Edit annotation"
          // Keeps the press from collapsing a selection or stealing focus before
          // the click opens the editor.
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            const annotation = annotations.find((item) => item.id === marker.id)
            if (!annotation) return
            const rect = event.currentTarget.getBoundingClientRect()
            onEdit(annotation, { x: rect.left + rect.width / 2, y: rect.top })
          }}
        >
          {marker.number}
        </button>
      ))}
    </>,
    document.body
  )
}
