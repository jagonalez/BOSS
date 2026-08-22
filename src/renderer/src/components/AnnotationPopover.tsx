/**
 * The affordance that turns a highlighted passage into an annotation.
 *
 * Selecting text inside an assistant reply raises a small toolbar over the
 * selection offering "Annotate" and "Side chat". Annotate opens an inline note
 * field; Side chat forks the thread and carries the passage across.
 *
 * The popover only appears for selections that stay inside one assistant
 * message — see `anchorFromSelection` for why a cross-message selection is
 * refused rather than clamped.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { anchorFromSelection, popoverAnchorPoint } from '../lib/annotation-anchor'
import { installSelectionListeners } from './annotation-popover-listeners'
import type { AnnotationAnchor } from '@shared/annotations'

interface PendingSelection {
  quote: string
  anchor: AnnotationAnchor
  x: number
  y: number
}

export function AnnotationPopover({
  scrollRef,
  onAnnotate,
  onSideChat
}: {
  scrollRef: React.RefObject<HTMLElement>
  onAnnotate: (quote: string, anchor: AnnotationAnchor, note: string) => void
  onSideChat: (quote: string, anchor: AnnotationAnchor) => void
}): React.JSX.Element | null {
  const [pending, setPending] = useState<PendingSelection | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  /** What the last pointerup landed on, so a deferred read can tell a fresh
   *  selection from a press on the popover's own buttons. */
  const lastPointerTarget = useRef<Node | null>(null)

  const dismiss = useCallback(() => {
    setPending(null)
    setNote(null)
  }, [])

  // Read the selection after the pointer settles. `selectionchange` fires for
  // every intermediate range while dragging, which would make the popover chase
  // the cursor across the message.
  //
  // The listeners go on `document` and this effect deliberately does not read
  // `scrollRef`. `ChatView` renders this component above the `.messages` div
  // the ref points at, so on the first render the ref is still null — the old
  // `if (!root) return` guard bailed there and, because a ref object's identity
  // is stable and `note` only moves once a popover exists, the effect never
  // re-ran once the div mounted. That left the toolbar permanently inert.
  // See annotation-popover-listeners.ts for the timing contract and its tests.
  useEffect(() => {
    const read = (): void => {
      // While the note field is open the selection is deliberately left behind;
      // re-reading it here would close the editor the moment it takes focus.
      if (note !== null) return
      // A pointerup on the popover itself is the user reaching for its buttons,
      // not making a new selection. Pressing a button collapses the selection,
      // so reading it here would find nothing and tear the popover down before
      // the click that opens the note field ever landed.
      if (popoverRef.current?.contains(lastPointerTarget.current)) return
      const found = anchorFromSelection(window.getSelection())
      if (!found) {
        setPending(null)
        return
      }
      const point = popoverAnchorPoint(found.range)
      if (!point) {
        setPending(null)
        return
      }
      setPending({ quote: found.quote, anchor: found.anchor, x: point.x, y: point.y })
    }

    return installSelectionListeners({
      document,
      scrollRef,
      read,
      onPointerTarget: (target) => {
        lastPointerTarget.current = target
      }
    })
  }, [note])

  // A highlight anchored to text that has scrolled away should not leave its
  // toolbar floating over unrelated content.
  useEffect(() => {
    const root = scrollRef.current
    if (!root || !pending) return
    const onScroll = (): void => dismiss()
    root.addEventListener('scroll', onScroll, { passive: true })
    return () => root.removeEventListener('scroll', onScroll)
  }, [scrollRef, pending, dismiss])

  useEffect(() => {
    if (!pending) return
    const onDown = (event: MouseEvent): void => {
      if (popoverRef.current?.contains(event.target as Node)) return
      dismiss()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') dismiss()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [pending, dismiss])

  useEffect(() => {
    if (note !== null) inputRef.current?.focus()
  }, [note])

  if (!pending) return null

  const commit = (): void => {
    onAnnotate(pending.quote, pending.anchor, (note ?? '').trim())
    window.getSelection()?.removeAllRanges()
    dismiss()
  }

  return createPortal(
    <div
      ref={popoverRef}
      className="annotation-popover"
      role="toolbar"
      aria-label="Annotate selection"
      style={{
        left: Math.min(Math.max(pending.x, 120), window.innerWidth - 120),
        top: Math.max(pending.y - 8, 8)
      }}
    >
      {note === null ? (
        <>
          <button className="annotation-action" onClick={() => setNote('')}>
            Annotate
          </button>
          <button
            className="annotation-action"
            onClick={() => {
              onSideChat(pending.quote, pending.anchor)
              window.getSelection()?.removeAllRanges()
              dismiss()
            }}
          >
            Side chat
          </button>
        </>
      ) : (
        <input
          ref={inputRef}
          className="annotation-note-input"
          value={note}
          placeholder="Annotate…"
          aria-label="Annotation note"
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              dismiss()
            }
          }}
        />
      )}
    </div>,
    document.body
  )
}
