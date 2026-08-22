/**
 * Installing the selection listeners for the annotation toolbar.
 *
 * Split out of `AnnotationPopover` so the *timing* contract can be tested
 * without a DOM: the bug this module exists to prevent was never about what the
 * listeners do, only about whether they were ever attached.
 *
 * The listeners go on `document`, not on the transcript container. That is the
 * whole reason the container may still be unmounted here: a selection is a
 * document-level concept, and the popover has no need to wait for the scroll
 * element to exist. `scrollRef` is passed in only so callers can read it later,
 * from a read() that runs long after mount.
 */

/** A pointer target is kept so a deferred read can tell a press on the popover
 *  from a fresh selection. */
export interface SelectionListenerOptions {
  document: Document
  scrollRef: { current: HTMLElement | null }
  /** Called after the browser has settled the selection. */
  read: () => void
  /** Records what the last pointerup landed on. */
  onPointerTarget?: (target: Node | null) => void
}

export function installSelectionListeners({
  document,
  scrollRef,
  read,
  onPointerTarget
}: SelectionListenerOptions): () => void {
  // Deliberately unused: there is no guard on it. Reading the container here is
  // what made the original effect return early on mount and never re-run,
  // leaving the whole feature inert. Kept in the signature because callers pass
  // it and future readers will look for it.
  void scrollRef

  // Yield once so the browser has finished updating the selection, then read.
  //
  // A timeout rather than `requestAnimationFrame`: rAF is tied to painting, and
  // a window that is hidden, minimised, or fully occluded may not paint for a
  // long time — or at all. The popover has nothing to do with a frame being
  // drawn, so waiting for one made it silently dead in exactly those cases.
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const readSoon = (): void => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      read()
    }, 0)
    timers.add(timer)
  }

  const onPointerUp = (event: PointerEvent): void => {
    onPointerTarget?.(event.target as Node | null)
    readSoon()
  }
  const onKeyUp = (event: KeyboardEvent): void => {
    if (!event.shiftKey && event.key !== 'Shift') return
    // Keyboard selection has no pointer behind it; a target left over from an
    // earlier click would wrongly look like a press on the popover.
    onPointerTarget?.(null)
    readSoon()
  }

  document.addEventListener('pointerup', onPointerUp)
  document.addEventListener('keyup', onKeyUp)

  return () => {
    document.removeEventListener('pointerup', onPointerUp)
    document.removeEventListener('keyup', onKeyUp)
    // A pending read would otherwise land after teardown, reading a selection
    // these listeners no longer own.
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
  }
}
