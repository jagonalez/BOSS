/** The element each tab's content is painted into.
 *
 *  One per tab, created once and moved between panes rather than rebuilt. A
 *  React portal aimed at a new container tears down its DOM and builds it
 *  again, so repointing one at each pane destroyed the content every time a tab
 *  was dragged, split or left beside a closing pane. Moving the node keeps it,
 *  along with its scroll, selection and anything else the DOM holds.
 *
 *  Kept here rather than in the component for the reason the terminal and
 *  browser caches exist: React unmounts a component whenever its tab moves, and
 *  StrictMode unmounts everything once on purpose, so a node owned by a
 *  component would be discarded by the very events it has to survive. */
const nodes = new Map<string, HTMLDivElement>()

export function tabContentNode(tabId: string): HTMLDivElement {
  const existing = nodes.get(tabId)
  if (existing) return existing
  const node = document.createElement('div')
  node.className = 'workspace-tab-content'
  nodes.set(tabId, node)
  return node
}

/** Called when a tab is closed for good, next to where a terminal's shell and a
 *  browser's page are disposed. Not on unmount: that fires on every move. */
export function disposeTabContentNode(tabId: string): void {
  nodes.get(tabId)?.remove()
  nodes.delete(tabId)
}
