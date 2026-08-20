export type AppPage = 'command-center' | 'automations' | 'sites' | 'project' | 'chat'

export type WorkspaceTabKind = 'thread' | 'browser' | 'terminal' | 'review' | 'files'
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
  /** Set when this view belongs to one thread rather than to the user.
   *
   *  A review view is an ordinary view — same panes, same tabs, same content
   *  nodes — that happens to hold one thread's work and is chrome'd as a
   *  review. Making it a view rather than a new surface is what lets terminals
   *  and browsers open inside it: a tab still lives in exactly one pane, so
   *  nothing about how live content attaches has to change. */
  reviewSessionId?: string
}

/** Which list the sidebar shows. Independent of {@link MainMode}: finding a
 *  thread by project and reviewing it is a normal thing to want, and so is
 *  triaging a queue while panes keep running. */
export type SidebarMode = 'projects' | 'review'

/** Whether the main area shows the user's panes or one thread's review. */
export type MainMode = 'tiling' | 'review'

/** Every view in the app. Not scoped to a project: a view holds threads from
 *  wherever they live, and each thread carries its own checkout. */
export interface Workspace {
  views: WorkspaceView[]
  activeViewId: string
  updatedAt: number
  /** The tiling view to return to when review mode is switched off. Without
   *  it, leaving review would land on whichever view happened to be first. */
  tilingViewId?: string
}

/** A grid to arrange a view into: how many panes, and how they are split.
 *  Nothing about what goes in them — applying one moves the tabs you already
 *  have rather than opening anything. */
export interface Layout {
  id: string
  name: string
  root: WorkspaceNode
}
