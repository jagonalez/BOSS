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
}

/** Every view in the app. Not scoped to a project: a view holds threads from
 *  wherever they live, and each thread carries its own checkout. */
export interface Workspace {
  views: WorkspaceView[]
  activeViewId: string
  updatedAt: number
}

/** Reusable formats preserve structure and tab kinds, never project/session bindings. */
export interface LayoutTemplate {
  id: string
  name: string
  favorite: boolean
  builtIn?: boolean
  root: WorkspaceNode
}
