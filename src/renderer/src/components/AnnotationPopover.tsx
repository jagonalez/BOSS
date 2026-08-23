/**
 * The affordance that turns a highlighted passage into an annotation.
 *
 * Two layers, deliberately separate:
 *
 *  - A toolbar over the selection offering "Add to chat" and "Add to side
 *    chat". Neither commits anything on its own.
 *  - A note editor, which is where an annotation is actually written. It opens
 *    from the toolbar for a fresh selection, and from a numbered marker for one
 *    already placed — the same dialog either way, so revising a note is the
 *    same gesture as writing it.
 *
 * Keeping the editor addressable by an existing annotation is what makes a
 * placed highlight reachable again. Before this it was a dead end: the colour
 * said a note was attached, but the only way to change it was to remove the
 * pill above the composer and select the words a second time.
 *
 * The popover only appears for selections that stay inside one assistant
 * message — see `anchorFromSelection` for why a cross-message selection is
 * refused rather than clamped.
 */

import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { anchorFromSelection, popoverAnchorPoint } from '../lib/annotation-anchor'
import { installSelectionListeners } from './annotation-popover-listeners'
import type { Annotation, AnnotationAnchor } from '@shared/annotations'

interface PendingSelection {
  quote: string
  anchor: AnnotationAnchor
  x: number
  y: number
}

/** An open note editor, over a fresh selection or an annotation already made. */
interface NoteDraft {
  /** Present when revising; absent when the note is being written the first time. */
  annotationId?: string
  quote: string
  anchor: AnnotationAnchor
  note: string
  x: number
  y: number
}

/** Lets the transcript's markers open the editor on an existing annotation. */
export interface AnnotationPopoverHandle {
  edit: (annotation: Annotation, at: { x: number; y: number }) => void
}

export function AnnotationPopover({
  handleRef,
  scrollRef,
  onAnnotate,
  onUpdateNote,
  onRemove,
  onSideChat
}: {
  handleRef?: React.Ref<AnnotationPopoverHandle>
  scrollRef: React.RefObject<HTMLElement>
  onAnnotate: (quote: string, anchor: AnnotationAnchor, note: string) => void
  onUpdateNote: (id: string, note: string) => void
  onRemove: (id: string) => void
  onSideChat: (quote: string, anchor: AnnotationAnchor) => void
}): React.JSX.Element | null {
  const [pending, setPending] = useState<PendingSelection | null>(null)
  const [note, setNote] = useState<NoteDraft | null>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  /** What the last pointerup landed on, so a deferred read can tell a fresh
   *  selection from a press on the popover's own buttons. */
  const lastPointerTarget = useRef<Node | null>(null)

  const dismiss = useCallback(() => {
    setPending(null)
    setNote(null)
  }, [])

  useImperativeHandle(
    handleRef,
    () => ({
      edit: (annotation, at) => {
        if (!annotation.anchor) return
        setPending(null)
        setNote({
          annotationId: annotation.id,
          quote: annotation.quote,
          anchor: annotation.anchor,
          note: annotation.note,
          x: at.x,
          y: at.y
        })
      }
    }),
    []
  )

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
      // Same for the markers, which live outside this component: a press on one
      // opens the editor, and reading the (now collapsed) selection here would
      // race that open and clear it.
      if (
        lastPointerTarget.current instanceof Element &&
        lastPointerTarget.current.closest('.annotation-marker')
      ) {
        return
      }
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
  // toolbar floating over unrelated content. The editor goes too: it is placed
  // at the words it belongs to, so it would otherwise drift over other text
  // with no sign of what it is attached to.
  useEffect(() => {
    const root = scrollRef.current
    if (!root || (!pending && !note)) return
    const onScroll = (): void => dismiss()
    root.addEventListener('scroll', onScroll, { passive: true })
    return () => root.removeEventListener('scroll', onScroll)
  }, [scrollRef, pending, note, dismiss])

  useEffect(() => {
    if (!pending && !note) return
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (popoverRef.current?.contains(target)) return
      if (editorRef.current?.contains(target)) return
      // A marker press is handled by the marker, which reopens the editor on
      // its own annotation; tearing down here would fight that.
      if (target instanceof Element && target.closest('.annotation-marker')) return
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
  }, [pending, note, dismiss])

  useEffect(() => {
    if (note !== null) inputRef.current?.focus()
  }, [note])

  const openNote = (from: PendingSelection): void => {
    setNote({ quote: from.quote, anchor: from.anchor, note: '', x: from.x, y: from.y })
    // The selection has served its purpose; leaving it highlighted competes
    // with the annotation highlight that is about to replace it.
    window.getSelection()?.removeAllRanges()
    setPending(null)
  }

  const commit = (draft: NoteDraft): void => {
    if (draft.annotationId) onUpdateNote(draft.annotationId, draft.note.trim())
    else onAnnotate(draft.quote, draft.anchor, draft.note.trim())
    dismiss()
  }

  return (
    <>
      {pending && !note
        ? createPortal(
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
              <button
                className="annotation-action"
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => openNote(pending)}
              >
                Add to chat
              </button>
              <button
                className="annotation-action"
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onSideChat(pending.quote, pending.anchor)
                  window.getSelection()?.removeAllRanges()
                  dismiss()
                }}
              >
                Add to side chat
              </button>
            </div>,
            document.body
          )
        : null}
      {note
        ? createPortal(
            <div
              ref={editorRef}
              className="annotation-editor"
              role="dialog"
              aria-label={note.annotationId ? 'Edit annotation' : 'New annotation'}
              style={{
                left: Math.min(Math.max(note.x, 140), window.innerWidth - 140),
                top: Math.max(note.y - 8, 8)
              }}
            >
              <input
                ref={inputRef}
                className="annotation-note-input"
                value={note.note}
                placeholder="Annotate…"
                aria-label="Annotation note"
                onChange={(event) => setNote({ ...note, note: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    commit(note)
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    dismiss()
                  }
                }}
              />
              {note.annotationId ? (
                <button
                  className="annotation-note-remove"
                  type="button"
                  aria-label="Remove annotation"
                  title="Remove annotation"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    onRemove(note.annotationId!)
                    dismiss()
                  }}
                >
                  ×
                </button>
              ) : null}
            </div>,
            document.body
          )
        : null}
    </>
  )
}
