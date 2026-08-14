import React, { useEffect, useRef, useState } from 'react'
import { useStore, appStore } from '../state/AppState'
import { BackIcon, ExternalIcon, ForwardIcon, ReloadIcon } from './icons'
function rectOf(el: HTMLElement): { x: number; y: number; width: number; height: number } {
  const r = el.getBoundingClientRect()
  return {
    x: Math.round(r.x),
    y: Math.round(r.y),
    width: Math.round(r.width),
    height: Math.round(r.height)
  }
}

export function BrowseTab({ id, visible = true }: { id: string; visible?: boolean }): React.JSX.Element {
  const viewRef = useRef<HTMLDivElement>(null)
  const nativeViewsSuspended = useStore(appStore, (s) => s.nativeViewSuspensions.length > 0)
  const nav = useStore(appStore, (s) => s.browse[id] ?? { url: '', title: '', canGoBack: false, canGoForward: false, loading: false })
  const [urlInput, setUrlInput] = useState('')

  // No destroy on unmount. StrictMode mounts, unmounts and remounts every
  // component in development, so this tore down the page the moment it was
  // created — the remount then built an empty view and the pane looked blank
  // with the url bar still filled in. A browser is disposed when its tab
  // closes, which closeWorkspaceTab handles; unmounting only means React
  // moved it, which is now routine.

  useEffect(() => {
    const el = viewRef.current
    // Hidden, not detached: a tab behind another in the same pane comes back
    // often, and re-adding the view each time is what made it slow.
    if (!el || !visible) {
      void window.boss.browseVisible(id, false)
      return
    }
    void window.boss.browseVisible(id, !nativeViewsSuspended)
    void window.boss.browseAttach(id, rectOf(el))
    const report = (): void => {
      void window.boss.browseBounds(id, rectOf(el))
    }
    const ro = new ResizeObserver(report)
    ro.observe(el)
    window.addEventListener('resize', report)

    // A native view is drawn at an explicit rect, so it has to be told when it
    // moves. ResizeObserver only reports size, and a tab dropped into a pane
    // of the same size moves without resizing — the view stayed painted over
    // the pane it came from, leaving the new one blank.
    //
    // Watching the document for structural changes catches the move itself:
    // the portal re-parents this element, and childList mutations fire for
    // that. Cheaper than polling the layout, and it needs no cooperation from
    // whoever did the moving.
    let last = rectOf(el)
    let pending = 0
    const sync = (): void => {
      const next = rectOf(el)
      if (next.x === last.x && next.y === last.y && next.width === last.width && next.height === last.height) return
      last = next
      void window.boss.browseBounds(id, next)
    }
    const observer = new MutationObserver(() => {
      // Mutation callbacks are microtasks, so they run before the browser has
      // laid the new position out — reading the rect here returns the old one.
      // Waiting a frame reads the geometry that actually shipped.
      cancelAnimationFrame(pending)
      pending = requestAnimationFrame(sync)
    })
    observer.observe(document.body, { childList: true, subtree: true })

    // No detach here. This effect re-runs whenever the tab moves, and React
    // runs cleanup before the next setup, so detaching first tore the view out
    // of the window and put it straight back — a full re-add, which is what
    // made the pane sit blank for a second or two after a drag. The view is
    // detached when the tab genuinely goes away, not when it moves.
    return () => {
      ro.disconnect()
      observer.disconnect()
      cancelAnimationFrame(pending)
      window.removeEventListener('resize', report)
    }
  }, [id, visible, nativeViewsSuspended])

  useEffect(() => {
    const off = window.boss.onBrowseNavigation((evt) => {
      if (evt.id === id) {
        appStore.setState((s) => ({ browse: { ...s.browse, [evt.id]: evt.state } }))
      }
    })
    return off
  }, [id])

  useEffect(() => {
    if (nav.url) setUrlInput(nav.url)
  }, [nav.url])

  const navigate = (): void => {
    let target = urlInput.trim()
    if (!target) return
    if (!/^https?:\/\//i.test(target)) target = `https://${target}`
    void window.boss.browseNavigate(id, target)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') navigate()
  }

  return (
    <div className="browse">
      <div className="browse-bar">
        <button className="btn-ghost" disabled={!nav.canGoBack} onClick={() => void window.boss.browseBack(id)} title="Back">
          <BackIcon size={14} />
        </button>
        <button className="btn-ghost" disabled={!nav.canGoForward} onClick={() => void window.boss.browseForward(id)} title="Forward">
          <ForwardIcon size={14} />
        </button>
        <button className="btn-ghost" onClick={() => void window.boss.browseReload(id)} title="Reload">
          <ReloadIcon size={14} />
        </button>
        {nav.url ? (
          <button
            className="btn-ghost"
            onClick={() => void window.boss.openExternal(nav.url)}
            title="Open in default browser"
          >
            <ExternalIcon size={14} />
          </button>
        ) : null}
        <input
          value={urlInput}
          placeholder="Search the web or enter a URL"
          onChange={(e) => setUrlInput(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
        />
        {nav.loading ? <div className="spinner" /> : null}
      </div>
      <div className="browse-view" ref={viewRef} />
    </div>
  )
}
