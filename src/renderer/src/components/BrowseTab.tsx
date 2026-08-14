import React, { useEffect, useRef, useState } from 'react'
import { useStore, appStore } from '../state/AppState'
import { BackIcon, ExternalIcon, ForwardIcon, ReloadIcon } from './icons'
import { BROWSE_PARTITION, browseGuests, type BrowseGuest } from '../lib/browse-guests'

export function BrowseTab({ id, visible = true }: { id: string; visible?: boolean }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const nav = useStore(appStore, (s) => s.browse[id] ?? { url: '', title: '', canGoBack: false, canGoForward: false, loading: false })
  const [urlInput, setUrlInput] = useState('')

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    let guest = browseGuests.get(id)
    if (!guest) {
      // createElement rather than JSX: React does not know the webview tag,
      // and the element has to survive its component anyway.
      guest = document.createElement('webview') as BrowseGuest
      guest.setAttribute('partition', BROWSE_PARTITION)
      guest.setAttribute('allowpopups', 'false')
      guest.className = 'browse-guest'
      browseGuests.set(id, guest)

      // The one thing the DOM cannot do: hand the page to the main process so
      // agent tools reach it directly rather than through the renderer.
      guest.addEventListener('dom-ready', () => {
        void window.boss.browseRegister(id, guest!.getWebContentsId())
      })
    }

    // A move is an appendChild, and the page carries on. This is the whole
    // reason for the switch away from a native view.
    if (guest.parentElement !== host) host.appendChild(guest)

    return () => {
      // Left in the DOM deliberately: unmounting means the tab moved.
    }
  }, [id])

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
    <div className="browse" hidden={!visible}>
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
      <div className="browse-view" ref={hostRef} />
    </div>
  )
}
