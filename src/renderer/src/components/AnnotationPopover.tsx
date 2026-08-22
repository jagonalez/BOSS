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
  useEffect(() => {
    const root = scrollRef.current
    if (!root) return

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

    // Yield once so the browser has finished updating the selection, then read.
    //
    // A timeout rather than `requestAnimationFrame`: rAF is tied to painting,
    // and a window that is hidden, minimised, or fully occluded may not paint
    // for a long time — or at all. The popover has nothing to do with a frame
    // being drawn, so waiting for one made it silently dead in exactly those
    // cases, which is also why it never opened under the hidden E2E window.
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const readSoon = (): void => {
      const timer = setTimeout(() => {
        timers.delete(timer)
        read()
      }, 0)
      timers.add(timer)
    }

    const onPointerUp = (event: PointerEvent): void => {
      lastPointerTarget.current = event.target as Node | null
      readSoon()
    }
    const onKeyUp = (event: KeyboardEvent): void => {
      if (!event.shiftKey && event.key !== 'Shift') return
      // Keyboard selection has no pointer behind it; a target left over from an
      // earlier click would wrongly look like a press on the popover.
      lastPointerTarget.current = null
      readSoon()
    }

    document.addEventListener('pointerup', onPointerUp)
    document.addEventListener('keyup', onKeyUp)
    return () => {
      document.removeEventListener('pointerup', onPointerUp)
      document.removeEventListener('keyup', onKeyUp)
      // A pending read would otherwise land after the effect was torn down,
      // reading a selection this listener no longer owns.
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
    }
  }, [scrollRef, note])

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
