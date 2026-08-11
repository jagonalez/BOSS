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
  const actuallyVisible = visible && !nativeViewsSuspended
  const nav = useStore(appStore, (s) => s.browse[id] ?? { url: '', title: '', canGoBack: false, canGoForward: false, loading: false })
  const [urlInput, setUrlInput] = useState('')

  useEffect(() => {
    return () => {
      void window.ralf.browseDetach(id)
      void window.ralf.browseDestroy(id)
    }
  }, [id])

  useEffect(() => {
    const el = viewRef.current
    if (!el || !actuallyVisible) {
      void window.ralf.browseDetach(id)
      return
    }
    void window.ralf.browseAttach(id, rectOf(el))
    const report = (): void => {
      void window.ralf.browseBounds(id, rectOf(el))
    }
    const ro = new ResizeObserver(report)
    ro.observe(el)
    window.addEventListener('resize', report)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', report)
      void window.ralf.browseDetach(id)
    }
  }, [id, actuallyVisible])

  useEffect(() => {
    const off = window.ralf.onBrowseNavigation((evt) => {
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
    void window.ralf.browseNavigate(id, target)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') navigate()
  }

  return (
    <div className="browse">
      <div className="browse-bar">
        <button className="btn-ghost" disabled={!nav.canGoBack} onClick={() => void window.ralf.browseBack(id)} title="Back">
          <BackIcon size={14} />
        </button>
        <button className="btn-ghost" disabled={!nav.canGoForward} onClick={() => void window.ralf.browseForward(id)} title="Forward">
          <ForwardIcon size={14} />
        </button>
        <button className="btn-ghost" onClick={() => void window.ralf.browseReload(id)} title="Reload">
          <ReloadIcon size={14} />
        </button>
        {nav.url ? (
          <button
            className="btn-ghost"
            onClick={() => void window.ralf.openExternal(nav.url)}
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
