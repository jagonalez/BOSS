/** What a resource tab had on screen, kept outside React.
 *
 *  Moving a tab to another pane repoints its portal at a different container,
 *  and a portal rebuilds its DOM rather than moving it. The component remounts
 *  even though React never removed it from the tree, so anything in component
 *  state is lost — a files tab forgot which file was open, a review tab its
 *  place in the diff.
 *
 *  Terminals and browsers never had this problem because their state was
 *  already held in a module cache keyed by tab id. This is the same idea for
 *  the tabs that keep theirs in React.
 *
 *  Only what is cheap to hold and annoying to lose — the choices a user made,
 *  not the data they produced. File contents and diffs stay out: they are
 *  re-read on mount, and a branch-sized diff held forever per tab is a real
 *  cost where a handful of strings is not. */

export interface FilesViewState {
  expanded: string[]
  openPaths: string[]
  activePath: string | null
  treeWidth: number
}

export interface ReviewViewState {
  scope: string
  baseBranch: string
  selectedCommit: string | null
}

const files = new Map<string, FilesViewState>()
const reviews = new Map<string, ReviewViewState>()

export function filesViewState(tabId: string | undefined): FilesViewState | undefined {
  return tabId ? files.get(tabId) : undefined
}

export function rememberFilesView(tabId: string | undefined, state: FilesViewState): void {
  if (tabId) files.set(tabId, state)
}

export function reviewViewState(tabId: string | undefined): ReviewViewState | undefined {
  return tabId ? reviews.get(tabId) : undefined
}

export function rememberReviewView(tabId: string | undefined, state: ReviewViewState): void {
  if (tabId) reviews.set(tabId, state)
}

/** Called when a tab is closed for good. Without this the map grows for the
 *  life of the app, holding paths for tabs that no longer exist. */
export function forgetTabView(tabId: string): void {
  files.delete(tabId)
  reviews.delete(tabId)
}
