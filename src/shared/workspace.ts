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

export interface ProjectWorkspace {
  version: 3
  projectKey: string
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
