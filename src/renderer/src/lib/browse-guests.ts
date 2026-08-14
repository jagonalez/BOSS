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

/** What the url bar does with what you typed.
 *
 *  A bare word is a search, not a hostname: "electron" became
 *  https://electron and failed. Something with a dot and no spaces is treated
 *  as a host, which is the guess every browser makes — it is wrong for a
 *  sentence containing a domain, and right almost everywhere else. */
export function asUrl(typed: string): string {
  const text = typed.trim()
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text
  if (text.startsWith('localhost') || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?/.test(text)) return `http://${text}`
  const looksLikeHost = !/\s/.test(text) && /^[^\s/?#]+\.[^\s/?#]{2,}/.test(text)
  if (looksLikeHost) return `https://${text}`
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`
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
