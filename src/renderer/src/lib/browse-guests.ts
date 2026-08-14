/** The hardened partition every browser pane runs in. Checked again in the
 *  main process, which refuses to attach a guest asking for anything else. */
export const BROWSE_PARTITION = 'persist:boss-browse'

/** What BOSS uses of the webview element. Declared here rather than pulling
 *  Electron's types into the renderer, which does not otherwise need them. */
export interface BrowseGuest extends HTMLElement {
  getWebContentsId(): number
  loadURL(url: string): Promise<void>
  goBack(): void
  goForward(): void
  reload(): void
}

/** Live guest pages, keyed by tab.
 *
 *  The element outlives its component for the same reason a terminal's does:
 *  React unmounts a tab whenever it moves between panes, and StrictMode
 *  unmounts everything once in development. Destroying the page there would
 *  throw away whatever the user was looking at.
 *
 *  Lives here rather than beside the component so the close actions can reach
 *  it without importing a component. */
export const browseGuests = new Map<string, BrowseGuest>()

export function disposeBrowseGuest(id: string): void {
  const guest = browseGuests.get(id)
  if (!guest) return
  browseGuests.delete(id)
  void window.boss.browseUnregister(id)
  guest.remove()
}
