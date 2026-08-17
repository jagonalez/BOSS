import React, { useEffect, useRef, useState } from 'react'
import { useStore, appStore } from '../state/AppState'
import { ReloadIcon } from './icons'
import { PLUGIN_PARTITION, pluginGuests, pluginViewUrl, type PluginGuest } from '../lib/plugin-guests'

/**
 * A plugin's own page, in a pane.
 *
 * Deliberately thinner than BrowseTab: there is no url bar, no history, and no
 * navigation, because a plugin view is one page at a fixed address. What it can
 * do it does through window.bossPlugin.call, which the plugin preload exposes
 * and the main process brokers against the plugin's own MCP server.
 */
export function PluginTab({
  id,
  pluginId,
  viewId,
  visible = true
}: {
  id: string
  pluginId?: string
  viewId?: string
  visible?: boolean
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)
  const plugin = useStore(appStore, (state) => state.plugins.find((item) => item.manifest.id === pluginId))

  useEffect(() => {
    const host = hostRef.current
    if (!host || !pluginId || !viewId) return

    let guest = pluginGuests.get(id)
    if (!guest) {
      // createElement rather than JSX, as in BrowseTab: React does not know the
      // webview tag, and the element has to outlive its component.
      guest = document.createElement('webview') as PluginGuest
      guest.setAttribute('partition', PLUGIN_PARTITION)
      guest.setAttribute('allowpopups', 'false')
      guest.setAttribute('src', pluginViewUrl(pluginId, viewId))
      guest.className = 'plugin-guest'
      pluginGuests.set(id, guest)
      guest.addEventListener('did-fail-load', () => setFailed(true))
      guest.addEventListener('did-finish-load', () => setFailed(false))
    }

    if (guest.parentElement !== host) host.appendChild(guest)

    return () => {
      // Left in the DOM deliberately: unmounting means the tab moved.
    }
  }, [id, pluginId, viewId])

  // A plugin that reloaded on disk, or was turned off and on, serves different
  // files under the same URL. Reloading the guest is what picks that up.
  const status = plugin?.status
  useEffect(() => {
    if (status === 'ready') pluginGuests.get(id)?.reload()
  }, [id, status])

  if (!pluginId || !viewId) {
    return <div className="workspace-unbound">This tab is not bound to a plugin view.</div>
  }

  const title = plugin?.manifest.views?.find((view) => view.id === viewId)?.title ?? plugin?.manifest.name

  return (
    <div className="plugin-tab" hidden={!visible}>
      <div className="plugin-bar">
        <span className="plugin-bar-title">{title ?? pluginId}</span>
        {plugin && plugin.status !== 'ready' ? (
          <span className="plugin-bar-status">
            {plugin.status === 'error' ? plugin.error || 'This plugin failed to start.' : plugin.status}
          </span>
        ) : null}
        <button className="btn-ghost" onClick={() => pluginGuests.get(id)?.reload()} title="Reload this view">
          <ReloadIcon size={14} />
        </button>
      </div>
      <div className="plugin-view" ref={hostRef}>
        {failed ? (
          <div className="plugin-empty">
            This view did not load. Check that {pluginId}&apos;s entry file exists.
          </div>
        ) : null}
      </div>
    </div>
  )
}
