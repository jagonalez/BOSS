export type AppPage = 'command-center' | 'automations' | 'sites' | 'project' | 'chat'

export type WorkspaceTabKind = 'thread' | 'browser' | 'terminal' | 'review' | 'files'
export type SplitDirection = 'horizontal' | 'vertical'
export type DropPosition = 'center' | 'left' | 'right' | 'top' | 'bottom'

export interface WorkspaceTab {
  id: string
  kind: WorkspaceTabKind
  sessionId?: string
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

export interface ProjectWorkspace {
  version: 2
  projectKey: string
  root: WorkspaceNode
  focusedGroupId: string
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
