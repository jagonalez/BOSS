/** The partition every plugin view runs in. Checked again in the main process,
 *  which attaches the plugin preload only for this partition and refuses any
 *  other combination. */
export const PLUGIN_PARTITION = 'persist:boss-plugin'

/** What BOSS uses of a plugin view's webview element. */
export interface PluginGuest extends HTMLElement {
  loadURL(url: string): Promise<void>
  reload(): void
  getURL(): string
}

/** A plugin view's address. One origin per plugin, so two plugins' pages cannot
 *  reach each other and the main process can read the plugin id from the URL. */
export function pluginViewUrl(pluginId: string, viewId: string): string {
  return `boss-plugin://${pluginId}/${viewId}`
}

/** Live plugin pages, keyed by tab, for the same reason browseGuests exists: a
 *  tab moving between panes unmounts its component, and a plugin view holding
 *  half-typed input should survive that. */
export const pluginGuests = new Map<string, PluginGuest>()

export function disposePluginGuest(id: string): void {
  const guest = pluginGuests.get(id)
  if (!guest) return
  pluginGuests.delete(id)
  guest.remove()
}
