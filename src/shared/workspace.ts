export type AppPage = 'home' | 'lab-assistant' | 'automations' | 'workflows' | 'reports' | 'sites' | 'project' | 'chat'

export type WorkspaceTabKind = 'thread' | 'agents' | 'browser' | 'terminal' | 'review' | 'files'
export type SplitDirection = 'horizontal' | 'vertical'
export type DropPosition = 'center' | 'left' | 'right' | 'top' | 'bottom'
export type TerminalStartLocation = 'focused-checkout' | 'project-root'

export interface WorkspaceCheckoutBinding {
  contextPath: string
  worktreeId?: string
  contextLabel?: string
}

export interface WorkspaceTab {
  id: string
  kind: WorkspaceTabKind
  sessionId?: string
  /** A name the user gave this resource. Without one the tab is called after
   *  its kind, which stops telling them apart once a thread owns two
   *  terminals. Threads take their name from the session instead. */
  title?: string
  /** Checkout used by terminal, review, and files. Once created, the tab stays pinned here. */
  contextPath?: string
  worktreeId?: string
  contextLabel?: string
}

export interface WorkspaceGroup {
  id: string
  type: 'group'
  tabs: WorkspaceTab[]
  activeTabId: string | null
}

export interface WorkspaceSplit {
  id: string
  type: 'split'
  direction: SplitDirection
  ratio: number
  first: WorkspaceNode
  second: WorkspaceNode
}

export type WorkspaceNode = WorkspaceGroup | WorkspaceSplit

export interface WorkspaceView {
  id: string
  name: string
  root: WorkspaceNode
  focusedGroupId: string
}

/** How the workspace displays.
 *
 *  'multi' is the tiling layout: several threads at once, split however the
 *  user arranged them. 'single' shows one thread in one pane with its own tabs
 *  — no splits, no view tabs — for when the layout is a distraction rather than
 *  the point.
 *
 *  A setting rather than a per-thread mode. Which one suits you depends on how
 *  you work, not on which thread you happen to be looking at. */
export type ViewMode = 'single' | 'multi'

/** Every view in the app. Not scoped to a project: a view holds threads from
 *  wherever they live, and each thread carries its own checkout. */
export interface Workspace {
  views: WorkspaceView[]
  activeViewId: string
  updatedAt: number
}

/** A grid to arrange a view into: how many panes, and how they are split.
 *  Nothing about what goes in them — applying one moves the tabs you already
 *  have rather than opening anything. */
export interface Layout {
  id: string
  name: string
  root: WorkspaceNode
}
