/**
 * Regression test for the annotation toolbar shipping completely inert.
 *
 * PR #121 landed with a clean typecheck and passing unit tests while selecting
 * text produced no toolbar at all, because the only unit coverage was
 * `resolveRuns` — pure offset arithmetic that never touches a component. The
 * defect lived entirely in *when* an effect ran, so no amount of testing
 * `anchorFromSelection` in isolation could have caught it.
 *
 * What actually broke: `AnnotationPopover` opened its listener effect with
 *
 *     const root = scrollRef.current
 *     if (!root) return
 *
 * `ChatView` renders `<AnnotationPopover scrollRef={scrollRef} />` *above* the
 * `<div className="messages" ref={scrollRef}>` the ref points at, so on the
 * first render `scrollRef.current` is null and the effect bailed. Its deps were
 * `[scrollRef, note]`: a ref object's identity never changes and `note` only
 * moves once a popover already exists, so the effect never re-ran once the div
 * mounted. `pointerup` was therefore never bound and no selection could ever
 * open the toolbar.
 *
 * So this test mounts the effect in that exact order — consumer first, scroll
 * container second — and asserts the document listeners are bound anyway. It
 * fails against the pre-fix code and passes after.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
// Node's type-stripping test runner requires explicit extensions.
// @ts-expect-error Application code uses bundler resolution.
import { installSelectionListeners } from './annotation-popover-listeners.ts'

/** The handful of `document` methods the listener installer actually uses. */
function fakeDocument(): {
  document: Document
  bound: Map<string, number>
} {
  const bound = new Map<string, number>()
  const document = {
    addEventListener(type: string): void {
      bound.set(type, (bound.get(type) ?? 0) + 1)
    },
    removeEventListener(type: string): void {
      bound.set(type, (bound.get(type) ?? 0) - 1)
    }
  } as unknown as Document
  return { document, bound }
}

test('listeners bind when the scroll container has not mounted yet', () => {
  const { document, bound } = fakeDocument()
  // Exactly the state on ChatView's first render: the popover is rendered
  // before the `.messages` div, so its ref is still empty.
  const scrollRef: { current: HTMLElement | null } = { current: null }

  installSelectionListeners({ document, scrollRef, read: () => {} })

  // The pre-fix `if (!root) return` left both of these at 0 forever, which is
  // precisely why the feature was dead in the running app.
  assert.equal(bound.get('pointerup'), 1)
  assert.equal(bound.get('keyup'), 1)
})

test('teardown removes exactly what was bound', () => {
  const { document, bound } = fakeDocument()
  const scrollRef: { current: HTMLElement | null } = { current: null }

  const dispose = installSelectionListeners({ document, scrollRef, read: () => {} })
  dispose()

  assert.equal(bound.get('pointerup'), 0)
  assert.equal(bound.get('keyup'), 0)
})

test('a pointerup with the container mounted schedules a read', async () => {
  const { document } = fakeDocument()
  const handlers = new Map<string, (event: unknown) => void>()
  const recording = {
    addEventListener(type: string, handler: (event: unknown) => void): void {
      handlers.set(type, handler)
    },
    removeEventListener(): void {}
  } as unknown as Document
  void document

  let reads = 0
  const scrollRef: { current: HTMLElement | null } = { current: null }
  installSelectionListeners({
    document: recording,
    scrollRef,
    read: () => {
      reads += 1
    }
  })

  // The container mounts after the effect ran — the ordering that broke this.
  scrollRef.current = {} as HTMLElement
  handlers.get('pointerup')?.({ target: null })

  // The read is deferred a tick so the browser can settle the selection.
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(reads, 1)
})

test('a keyup without shift is not a selection and does not read', async () => {
  const handlers = new Map<string, (event: unknown) => void>()
  const recording = {
    addEventListener(type: string, handler: (event: unknown) => void): void {
      handlers.set(type, handler)
    },
    removeEventListener(): void {}
  } as unknown as Document

  let reads = 0
  installSelectionListeners({
    document: recording,
    scrollRef: { current: null },
    read: () => {
      reads += 1
    }
  })

  handlers.get('keyup')?.({ shiftKey: false, key: 'a' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(reads, 0)
})

test('pending reads are cancelled on teardown', async () => {
  const handlers = new Map<string, (event: unknown) => void>()
  const recording = {
    addEventListener(type: string, handler: (event: unknown) => void): void {
      handlers.set(type, handler)
    },
    removeEventListener(): void {}
  } as unknown as Document

  let reads = 0
  const dispose = installSelectionListeners({
    document: recording,
    scrollRef: { current: null },
    read: () => {
      reads += 1
    }
  })

  handlers.get('pointerup')?.({ target: null })
  // Torn down before the deferred read lands; it must not fire against a
  // selection this effect no longer owns.
  dispose()

  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(reads, 0)
})
