import type {
  DropPosition,
  LayoutTemplate,
  Workspace,
  SplitDirection,
  WorkspaceGroup,
  WorkspaceNode,
  WorkspaceTab,
  WorkspaceCheckoutBinding,
  WorkspaceTabKind,
  WorkspaceView
} from '@shared/workspace'

// Unversioned: nothing has shipped, so there is no other shape in the world to
// migrate from. Version these at the first release, not before.
const WORKSPACES_KEY = 'boss.workspace'
const TEMPLATES_KEY = 'boss.layoutTemplates'
/** Drag payload for a workspace tab. Shared so the sidebar can start a drag the
 *  panes already know how to accept. */
export const TAB_DRAG_TYPE = 'application/x-boss-workspace-tab'

let sequence = 0

export function workspaceId(prefix: string): string {
  sequence += 1
  return `${prefix}-${Date.now().toString(36)}-${sequence.toString(36)}`
}

export function tab(kind: WorkspaceTabKind, sessionId?: string, checkout?: WorkspaceCheckoutBinding): WorkspaceTab {
  return { id: workspaceId('tab'), kind, sessionId, ...checkout }
}

export function group(tabs: WorkspaceTab[] = []): WorkspaceGroup {
  return { id: workspaceId('group'), type: 'group', tabs, activeTabId: tabs[0]?.id ?? null }
}

export function workspaceView(name = 'Workspace', root: WorkspaceNode = group()): WorkspaceView {
  const first = walkGroups(root)[0]
  return { id: workspaceId('workspace'), name, root, focusedGroupId: first.id }
}

export function nextWorkspaceViewName(views: Array<Pick<WorkspaceView, 'name'>>): string {
  const highest = views.reduce((current, view) => {
    const match = /^View (\d+)$/.exec(view.name)
    if (!match) return current
    const value = Number.parseInt(match[1], 10)
    return Number.isFinite(value) ? Math.max(current, value) : current
  }, 1)
  return `View ${highest + 1}`
}

/** Align a menu's right edge with its trigger while keeping the whole menu
 * inside the workspace group. Values are relative to the viewport. */
export function workspaceMenuRight(
  triggerRight: number,
  containerLeft: number,
  containerRight: number,
  menuWidth = 220,
  inset = 8
): number {
  const containerWidth = Math.max(0, containerRight - containerLeft)
  const desired = containerRight - triggerRight
  const maximum = Math.max(inset, containerWidth - Math.min(menuWidth, Math.max(0, containerWidth - inset * 2)) - inset)
  return Math.min(Math.max(inset, desired), maximum)
}

export function split(
  direction: SplitDirection,
  first: WorkspaceNode,
  second: WorkspaceNode,
  ratio = 0.5
): WorkspaceNode {
  return { id: workspaceId('split'), type: 'split', direction, ratio, first, second }
}

function cloneTab(item: WorkspaceTab, stripBindings: boolean): WorkspaceTab {
  const checkout = stripBindings || !item.contextPath
    ? undefined
    : { contextPath: item.contextPath, worktreeId: item.worktreeId, contextLabel: item.contextLabel }
  return tab(item.kind, stripBindings ? undefined : item.sessionId, checkout)
}

export function cloneLayout(node: WorkspaceNode, stripBindings = false): WorkspaceNode {
  if (node.type === 'group') {
    const tabs = node.tabs.map((item) => cloneTab(item, stripBindings))
    return group(tabs)
  }
  return split(node.direction, cloneLayout(node.first, stripBindings), cloneLayout(node.second, stripBindings), node.ratio)
}

export const BUILTIN_TEMPLATES: LayoutTemplate[] = [
  { id: 'builtin-focus', name: 'Focus', favorite: true, builtIn: true, root: group([tab('thread')]) },
  {
    id: 'builtin-side-by-side',
    name: 'Side by side',
    favorite: true,
    builtIn: true,
    root: split('horizontal', group([tab('thread')]), group([tab('thread')]))
  },
  {
    id: 'builtin-web-development',
    name: 'Web development',
    favorite: true,
    builtIn: true,
    root: split(
      'horizontal',
      group([tab('thread')]),
      split('vertical', group([tab('browser'), tab('browser')]), group([tab('terminal'), tab('files')]), 0.58),
      0.62
    )
  },
  {
    id: 'builtin-implementation-review',
    name: 'Implementation + review',
    favorite: true,
    builtIn: true,
    root: split('horizontal', group([tab('thread')]), group([tab('review'), tab('files')]), 0.64)
  },
  {
    id: 'builtin-four-up',
    name: 'Four up',
    favorite: true,
    builtIn: true,
    root: split(
      'horizontal',
      split('vertical', group([tab('thread')]), group([tab('thread')])),
      split('vertical', group([tab('browser')]), group([tab('terminal')]))
    )
  }
]

function isTab(value: unknown): value is WorkspaceTab {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<WorkspaceTab>
  return typeof item.id === 'string' && ['thread', 'browser', 'terminal', 'review', 'files'].includes(item.kind ?? '')
}

function isNode(value: unknown): value is WorkspaceNode {
  if (!value || typeof value !== 'object') return false
  const node = value as Partial<WorkspaceNode>
  if (node.type === 'group') return typeof node.id === 'string' && Array.isArray(node.tabs) && node.tabs.every(isTab)
  return node.type === 'split' && typeof node.id === 'string' && isNode(node.first) && isNode(node.second)
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* The live workspace remains usable when persistence is unavailable. */
  }
}

export function loadTemplates(): LayoutTemplate[] {
  const saved = readJson<LayoutTemplate[]>(TEMPLATES_KEY, [])
    .filter((item) => item && typeof item.id === 'string' && typeof item.name === 'string' && isNode(item.root))
    .map((item) => ({ ...item, builtIn: false }))
  return [...BUILTIN_TEMPLATES.map((item) => ({ ...item, root: cloneLayout(item.root, true) })), ...saved]
}

export function saveCustomTemplates(templates: LayoutTemplate[]): void {
  writeJson(TEMPLATES_KEY, templates.filter((item) => !item.builtIn))
}

export function saveWorkspace(workspace: Workspace): void {
  writeJson(WORKSPACES_KEY, { ...workspace, updatedAt: Date.now() })
}

/** One set of views for the whole app.
 *
 *  Views used to be stored per project, which fought the model: a view holds
 *  threads from anywhere, so keying the store by project meant switching
 *  projects swapped your layout out from under you, and going back showed a
 *  different one. A thread carries its own project, so nothing above it needs
 *  to. */
export function loadWorkspace(sessionId?: string): Workspace {
  const saved = readJson<Workspace | null>(WORKSPACES_KEY, null)
  if (
    Array.isArray(saved?.views) &&
    saved.views.length > 0 &&
    saved.views.every((view) => view && typeof view.id === 'string' && typeof view.name === 'string' && isNode(view.root))
  ) {
    return saved
  }
  // Anything else is a shape this build does not read, so start fresh rather
  // than carry a reader for it. A layout is an arrangement, not content.
  const root = group(sessionId ? [tab('thread', sessionId)] : [])
  const view = workspaceView('Main', root)
  return { views: [view], activeViewId: view.id, updatedAt: Date.now() }
}

export function activeWorkspaceView(workspace: Workspace): WorkspaceView {
  return workspace.views.find((view) => view.id === workspace.activeViewId) ?? workspace.views[0]
}

export function updateActiveWorkspaceView(
  workspace: Workspace,
  update: (view: WorkspaceView) => WorkspaceView
): Workspace {
  const active = activeWorkspaceView(workspace)
  return {
    ...workspace,
    activeViewId: active.id,
    views: workspace.views.map((view) => view.id === active.id ? update(view) : view)
  }
}

export function walkGroups(node: WorkspaceNode): WorkspaceGroup[] {
  return node.type === 'group' ? [node] : [...walkGroups(node.first), ...walkGroups(node.second)]
}

export function walkTabs(node: WorkspaceNode): WorkspaceTab[] {
  return walkGroups(node).flatMap((item) => item.tabs)
}

export function findGroup(node: WorkspaceNode, groupId: string): WorkspaceGroup | undefined {
  return walkGroups(node).find((item) => item.id === groupId)
}

export interface TabPlacement {
  viewId: string
  viewName: string
  groupId: string
}

/** Where every tab currently sits, keyed by tab id.
 *
 *  A tab is in a view because it is in that view's tree — the tree is the only
 *  record of placement, and storing a viewId on the tab would be a second copy
 *  of that fact, free to drift the moment a tab moves. This index is derived
 *  instead: rebuild it when the workspace changes and lookups stay O(1).
 *  Indexing 1152 tabs across 12 views measures at 40 µs. */
export function placementIndex(views: WorkspaceView[]): Map<string, TabPlacement> {
  const placements = new Map<string, TabPlacement>()
  for (const view of views) {
    for (const item of walkGroups(view.root)) {
      for (const candidate of item.tabs) {
        placements.set(candidate.id, { viewId: view.id, viewName: view.name, groupId: item.id })
      }
    }
  }
  return placements
}

export interface OwnedResource extends WorkspaceTab {
  viewId: string
  viewName: string
  groupId: string
}

/** Resources grouped by the thread that opened them, across every view.
 *
 *  A resource keeps its owner wherever it is dragged, so this is what lets the
 *  sidebar list a terminal under its thread while the terminal itself sits in
 *  another view. Threads are excluded: a thread is not its own resource. */
export function resourcesByThread(views: WorkspaceView[]): Map<string, OwnedResource[]> {
  const owned = new Map<string, OwnedResource[]>()
  for (const view of views) {
    for (const item of walkGroups(view.root)) {
      for (const candidate of item.tabs) {
        if (candidate.kind === 'thread' || !candidate.sessionId) continue
        const list = owned.get(candidate.sessionId) ?? []
        list.push({ ...candidate, viewId: view.id, viewName: view.name, groupId: item.id })
        owned.set(candidate.sessionId, list)
      }
    }
  }
  return owned
}

export function findTab(node: WorkspaceNode, tabId: string): { group: WorkspaceGroup; tab: WorkspaceTab } | undefined {
  for (const item of walkGroups(node)) {
    const found = item.tabs.find((candidate) => candidate.id === tabId)
    if (found) return { group: item, tab: found }
  }
  return undefined
}

export function findSessionTab(node: WorkspaceNode, sessionId: string): { group: WorkspaceGroup; tab: WorkspaceTab } | undefined {
  for (const item of walkGroups(node)) {
    const found = item.tabs.find((candidate) => candidate.kind === 'thread' && candidate.sessionId === sessionId)
    if (found) return { group: item, tab: found }
  }
  return undefined
}

export function mapNode(node: WorkspaceNode, id: string, update: (node: WorkspaceNode) => WorkspaceNode): WorkspaceNode {
  if (node.id === id) return update(node)
  if (node.type === 'group') return node
  return { ...node, first: mapNode(node.first, id, update), second: mapNode(node.second, id, update) }
}

export function updateGroup(root: WorkspaceNode, groupId: string, update: (item: WorkspaceGroup) => WorkspaceGroup): WorkspaceNode {
  return mapNode(root, groupId, (node) => (node.type === 'group' ? update(node) : node))
}

export function addTab(root: WorkspaceNode, groupId: string, item: WorkspaceTab): WorkspaceNode {
  return updateGroup(root, groupId, (target) => ({ ...target, tabs: [...target.tabs, item], activeTabId: item.id }))
}

export function activateTab(root: WorkspaceNode, groupId: string, tabId: string): WorkspaceNode {
  return updateGroup(root, groupId, (target) =>
    target.tabs.some((item) => item.id === tabId) ? { ...target, activeTabId: tabId } : target
  )
}

function removeTabFromGroup(target: WorkspaceGroup, tabId: string): { group: WorkspaceGroup; tab?: WorkspaceTab } {
  const index = target.tabs.findIndex((item) => item.id === tabId)
  if (index < 0) return { group: target }
  const removed = target.tabs[index]
  const tabs = target.tabs.filter((item) => item.id !== tabId)
  const activeTabId = target.activeTabId === tabId
    ? (tabs[index] ?? tabs[index - 1] ?? tabs[0])?.id ?? null
    : target.activeTabId
  return { group: { ...target, tabs, activeTabId }, tab: removed }
}

function collapseEmptyGroups(node: WorkspaceNode): WorkspaceNode {
  if (node.type === 'group') return node
  const first = collapseEmptyGroups(node.first)
  const second = collapseEmptyGroups(node.second)
  if (first.type === 'group' && first.tabs.length === 0) return second
  if (second.type === 'group' && second.tabs.length === 0) return first
  return { ...node, first, second }
}

export function closeTab(root: WorkspaceNode, groupId: string, tabId: string): WorkspaceNode {
  const updated = updateGroup(root, groupId, (target) => removeTabFromGroup(target, tabId).group)
  return collapseEmptyGroups(updated)
}

export function splitGroup(
  root: WorkspaceNode,
  groupId: string,
  direction: SplitDirection,
  item?: WorkspaceTab,
  placeFirst = false
): { root: WorkspaceNode; groupId: string } {
  const created = group(item ? [item] : [])
  return {
    root: mapNode(root, groupId, (node) => {
      if (node.type !== 'group') return node
      return placeFirst ? split(direction, created, node) : split(direction, node, created)
    }),
    groupId: created.id
  }
}

export function closeGroup(root: WorkspaceNode, groupId: string): WorkspaceNode {
  if (root.type === 'group') return root.id === groupId ? group() : root
  if (root.first.id === groupId) return root.second
  if (root.second.id === groupId) return root.first
  return { ...root, first: closeGroup(root.first, groupId), second: closeGroup(root.second, groupId) }
}

export function resizeSplit(root: WorkspaceNode, splitId: string, ratio: number): WorkspaceNode {
  return mapNode(root, splitId, (node) =>
    node.type === 'split' ? { ...node, ratio: Math.min(0.88, Math.max(0.12, ratio)) } : node
  )
}

export function moveTab(
  root: WorkspaceNode,
  tabId: string,
  targetGroupId: string,
  position: DropPosition
): { root: WorkspaceNode; focusedGroupId: string } {
  const source = findTab(root, tabId)
  if (!source) return { root, focusedGroupId: targetGroupId }
  if (source.group.id === targetGroupId && position === 'center') {
    return { root: activateTab(root, targetGroupId, tabId), focusedGroupId: targetGroupId }
  }
  if (source.group.id === targetGroupId && source.group.tabs.length === 1) {
    return { root, focusedGroupId: targetGroupId }
  }

  let without = updateGroup(root, source.group.id, (target) => removeTabFromGroup(target, tabId).group)
  without = collapseEmptyGroups(without)
  const target = findGroup(without, targetGroupId)
  if (!target) return { root, focusedGroupId: source.group.id }

  if (position === 'center') {
    return { root: addTab(without, targetGroupId, source.tab), focusedGroupId: targetGroupId }
  }
  const direction: SplitDirection = position === 'left' || position === 'right' ? 'horizontal' : 'vertical'
  const placeFirst = position === 'left' || position === 'top'
  const result = splitGroup(without, targetGroupId, direction, source.tab, placeFirst)
  return { root: result.root, focusedGroupId: result.groupId }
}

/** Move a tab to a group in any view, not only the active one.
 *
 *  A resource is dragged out of the sidebar, where it may be listed from a view
 *  the user is not looking at, so the source view has to be found rather than
 *  assumed. Within one view this is exactly moveTab, edge splits and all; only
 *  the crossing needs handling here, by lifting the tab out of its old view
 *  before moveTab places it in the new one. */
export function moveTabAcrossViews(
  views: WorkspaceView[],
  tabId: string,
  targetViewId: string,
  targetGroupId: string,
  position: DropPosition
): WorkspaceView[] {
  const source = views.find((view) => findTab(view.root, tabId))
  const target = views.find((view) => view.id === targetViewId)
  if (!source || !target) return views

  if (source.id === target.id) {
    const moved = moveTab(source.root, tabId, targetGroupId, position)
    return views.map((view) =>
      view.id === source.id ? { ...view, root: moved.root, focusedGroupId: moved.focusedGroupId } : view
    )
  }

  const lifted = findTab(source.root, tabId)
  if (!lifted) return views
  const without = collapseEmptyGroups(
    updateGroup(source.root, lifted.group.id, (item) => removeTabFromGroup(item, tabId).group)
  )
  // Re-add to the target, then let moveTab position it. Adding first keeps the
  // edge-split cases in one place rather than repeating splitGroup here.
  const seeded = addTab(target.root, targetGroupId, lifted.tab)
  const placed = position === 'center'
    ? { root: seeded, focusedGroupId: targetGroupId }
    : moveTab(seeded, tabId, targetGroupId, position)

  return views.map((view) => {
    if (view.id === source.id) {
      const focused = findGroup(without, view.focusedGroupId) ? view.focusedGroupId : walkGroups(without)[0].id
      return { ...view, root: without, focusedGroupId: focused }
    }
    if (view.id === target.id) return { ...view, root: placed.root, focusedGroupId: placed.focusedGroupId }
    return view
  })
}

export function reorderTab(root: WorkspaceNode, groupId: string, tabId: string, beforeTabId?: string): WorkspaceNode {
  return updateGroup(root, groupId, (target) => {
    const index = target.tabs.findIndex((item) => item.id === tabId)
    if (index < 0) return target
    const tabs = [...target.tabs]
    const [moved] = tabs.splice(index, 1)
    const before = beforeTabId ? tabs.findIndex((item) => item.id === beforeTabId) : -1
    tabs.splice(before >= 0 ? before : tabs.length, 0, moved)
    return { ...target, tabs }
  })
}

export function bindTemplate(
  template: LayoutTemplate,
  name: string,
  sessionIds: string[],
  checkout?: WorkspaceCheckoutBinding
): WorkspaceView {
  const root = cloneLayout(template.root, true)
  let sessionIndex = 0
  let reviewBound = false
  let filesBound = false
  const bind = (node: WorkspaceNode): WorkspaceNode => {
    if (node.type === 'split') return { ...node, first: bind(node.first), second: bind(node.second) }
    const tabs = node.tabs.filter((item) => {
      if (item.kind === 'review') {
        if (reviewBound) return false
        reviewBound = true
      }
      if (item.kind === 'files') {
        if (filesBound) return false
        filesBound = true
      }
      return true
    }).map((item) => {
      if (item.kind === 'thread') return { ...item, sessionId: sessionIds[sessionIndex++] }
      if (checkout && (item.kind === 'terminal' || item.kind === 'review' || item.kind === 'files')) {
        return { ...item, ...checkout }
      }
      return item
    })
    return { ...node, tabs, activeTabId: tabs[0]?.id ?? null }
  }
  const bound = bind(root)
  const first = walkGroups(bound)[0]
  return { id: workspaceId('workspace'), name, root: bound, focusedGroupId: first.id }
}

export function templateFromWorkspace(workspace: WorkspaceView, name: string): LayoutTemplate {
  return {
    id: workspaceId('format'),
    name: name.trim() || 'Untitled format',
    favorite: true,
    root: cloneLayout(workspace.root, true)
  }
}
