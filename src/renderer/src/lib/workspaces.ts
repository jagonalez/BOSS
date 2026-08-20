import type {
  DropPosition,
  Layout,
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
/** Drag payload for a workspace tab. Shared so the sidebar can start a drag the
 *  panes already know how to accept. */
export const TAB_DRAG_TYPE = 'application/x-boss-workspace-tab'

/** Drag payload for a thread that is not open yet, carrying its session id.
 *  Dropping one opens it where it lands, rather than moving a tab that does
 *  not exist. A thread already on screen drags as a TAB_DRAG_TYPE instead. */
export const SESSION_DRAG_TYPE = 'application/x-boss-session'

/** A project row dragged within the sidebar to reorder the list. Distinct from
 *  the thread and tab types so a project never drops into a view, where it has
 *  nothing to open. */
export const PROJECT_DRAG_TYPE = 'application/x-boss-project'

/** A new id for a tab, pane or view.
 *
 *  Random, not a counter. The counter reset to zero on every reload while the
 *  workspace itself was saved, so a tab made after a restart could take the id
 *  of one already on screen — the timestamp is only second-resolution in base
 *  36, so two tabs made in the same second after a reload collided outright.
 *
 *  Two tabs sharing an id is not a cosmetic problem. Tabs are keyed by id
 *  everywhere: the slot each one paints into, the terminal and browser caches,
 *  React's own reconciliation. A collision had two tabs overwriting each
 *  other's slot, so both unmounted and remounted repeatedly and a files tab
 *  lost its open file. */
/** Which checkout a resource opened from a thread should look at.
 *
 *  A thread working in a Git worktree edits files that do not exist in the main
 *  project checkout. A review opened without this binding fell back to that
 *  checkout and showed no files at all — the change was real, but in another
 *  repository. Undefined for a thread with no checkout of its own, which leaves
 *  the resource unbound rather than pointing it somewhere wrong. */
export function threadCheckout(
  session: { executionPath?: string; worktree?: { id?: string; path?: string; branch?: string } } | undefined
): WorkspaceCheckoutBinding | undefined {
  const contextPath = session?.executionPath ?? session?.worktree?.path
  if (!contextPath) return undefined
  return {
    contextPath,
    worktreeId: session?.worktree?.id,
    contextLabel: session?.worktree?.branch ?? 'Main'
  }
}

export function workspaceId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
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

/** A view for one thread: the conversation, and a panel beside it.
 *
 *  The conversation owns the left pane and never leaves it — in single mode it
 *  is the thread, not a tab you can close. Everything the thread accumulates
 *  (terminals, browsers, files, a side chat) goes in the right pane, which is
 *  an ordinary group and so brings its own tab strip, drag and drop, and close
 *  buttons with it.
 *
 *  The panel starts empty and is hidden until something is put in it, so a
 *  thread with nothing attached reads as one conversation filling the window.
 */
export function singleThreadView(name: string, sessionId: string): WorkspaceView {
  const conversation = group([tab('thread', sessionId)])
  const panel = group([])
  const view = workspaceView(name, split('horizontal', conversation, panel, 0.62))
  return { ...view, focusedGroupId: conversation.id }
}

/** The conversation pane of a single-thread view.
 *
 *  The pane holding a thread tab, not simply the first group: a view carried
 *  over from tiling can have its thread anywhere, and treating the wrong pane
 *  as the conversation hides the wrong tab strip. Falls back to the first
 *  group for a view that holds no thread at all. */
export function conversationGroupId(view: WorkspaceView): string {
  const groups = walkGroups(view.root)
  return groups.find((item) => item.tabs.some((entry) => entry.kind === 'thread'))?.id ?? groups[0].id
}

/** The pane a thread's terminals, files and reviews belong in: the one that is
 *  not its conversation. Undefined when the view has no second pane yet. */
export function panelGroupId(view: WorkspaceView): string | undefined {
  const conversation = conversationGroupId(view)
  return walkGroups(view.root).find((item) => item.id !== conversation)?.id
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

/** Grids, named for the shape they are.
 *
 *  These used to be "Focus", "Web development", "Four up" — and each named the
 *  tab kinds it wanted, so applying one decided you needed a browser and two
 *  terminals. A layout is only a shape: how many panes, arranged how. What
 *  goes in them is whatever you already have open. */
export const BUILTIN_LAYOUTS: Layout[] = [
  { id: 'grid-1x1', name: '1 × 1', root: group() },
  {
    id: 'grid-2x1',
    name: '2 × 1',
    root: split('horizontal', group(), group())
  },
  {
    id: 'grid-1x2',
    name: '1 × 2',
    root: split('vertical', group(), group())
  },
  {
    id: 'grid-3x1',
    name: '3 × 1',
    root: split('horizontal', group(), split('horizontal', group(), group()), 1 / 3)
  },
  {
    id: 'grid-2x2',
    name: '2 × 2',
    root: split(
      'horizontal',
      split('vertical', group(), group()),
      split('vertical', group(), group())
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

/** The grids. Cloned so applying one cannot mutate the shared shape. */
export function loadLayouts(): Layout[] {
  return BUILTIN_LAYOUTS.map((item) => ({ ...item, root: cloneLayout(item.root, true) }))
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
/** Give a repeated id a new one, leaving first uses alone.
 *
 *  Workspaces saved before ids were random can hold duplicates, and a duplicate
 *  is not survivable: tabs are keyed by id for the slot they paint into and for
 *  the terminal and browser caches, so two tabs with one id overwrite each
 *  other. Only the later use is renamed, so a tab that already owns a live
 *  terminal keeps it. */
export function withUniqueIds(workspace: Workspace): Workspace {
  const seen = new Set<string>()
  const fresh = (id: string, prefix: string): string => {
    if (!seen.has(id)) {
      seen.add(id)
      return id
    }
    const replacement = workspaceId(prefix)
    seen.add(replacement)
    return replacement
  }
  const fixNode = (node: WorkspaceNode): WorkspaceNode => {
    if (node.type === 'split') {
      return { ...node, id: fresh(node.id, 'split'), first: fixNode(node.first), second: fixNode(node.second) }
    }
    const tabs = node.tabs.map((item) => ({ ...item, id: fresh(item.id, 'tab') }))
    const activeIndex = node.tabs.findIndex((item) => item.id === node.activeTabId)
    return {
      ...node,
      id: fresh(node.id, 'group'),
      tabs,
      // By position: the id it pointed at may have just been replaced.
      activeTabId: activeIndex >= 0 ? tabs[activeIndex].id : tabs[0]?.id ?? null
    }
  }
  const views = workspace.views.map((view) => {
    const root = fixNode(view.root)
    const groups = walkGroups(root)
    return {
      ...view,
      id: fresh(view.id, 'view'),
      root,
      focusedGroupId: groups.some((item) => item.id === view.focusedGroupId) ? view.focusedGroupId : groups[0]?.id ?? view.focusedGroupId
    }
  })
  const activeViewId = views.some((view) => view.id === workspace.activeViewId)
    ? workspace.activeViewId
    : views[0]?.id ?? workspace.activeViewId
  return { ...workspace, views, activeViewId }
}

export function loadWorkspace(sessionId?: string): Workspace {
  const saved = readJson<Workspace | null>(WORKSPACES_KEY, null)
  if (
    Array.isArray(saved?.views) &&
    saved.views.length > 0 &&
    saved.views.every((view) => view && typeof view.id === 'string' && typeof view.name === 'string' && isNode(view.root))
  ) {
    return withUniqueIds(saved)
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

/** Rebuild a tree with every tab passed through `update`. */
export function mapTabs(node: WorkspaceNode, update: (item: WorkspaceTab) => WorkspaceTab): WorkspaceNode {
  if (node.type === 'group') return { ...node, tabs: node.tabs.map(update) }
  return { ...node, first: mapTabs(node.first, update), second: mapTabs(node.second, update) }
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

/** The resource a thread already has for this checkout, if any.
 *
 *  Owner as well as checkout. Matching on the checkout alone handed a thread
 *  the tab belonging to whichever thread asked first: the diff was right, but
 *  the sidebar files a resource under its owner, so it appeared under someone
 *  else's thread. A thread can also move between checkouts — an agent can put
 *  one on a fresh worktree mid-conversation — so the checkout is not a stable
 *  name for a thread's own resources. */
export function findOwnedResource(
  node: WorkspaceNode,
  kind: WorkspaceTabKind,
  sessionId: string | undefined,
  contextPath: string | undefined
): WorkspaceTab | undefined {
  return walkTabs(node).find((item) =>
    item.kind === kind && item.sessionId === sessionId && item.contextPath === contextPath
  )
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

/** Drop the one pane a tab just left, if leaving emptied it.
 *
 *  Only that pane. An empty pane is a place the user made to put something in,
 *  which is all a grid is, so collapsing every empty pane in the tree would
 *  delete the rest of the grid on the first drag. `keep` protects the pane
 *  being dropped on, which is empty right up to the moment the tab lands. */
function collapseEmptied(node: WorkspaceNode, emptiedId: string, keep?: string): WorkspaceNode {
  if (node.type === 'group') return node
  const gone = (child: WorkspaceNode): boolean =>
    child.type === 'group' && child.id === emptiedId && child.id !== keep && child.tabs.length === 0
  if (gone(node.first)) return node.second
  if (gone(node.second)) return node.first
  return {
    ...node,
    first: collapseEmptied(node.first, emptiedId, keep),
    second: collapseEmptied(node.second, emptiedId, keep)
  }
}

export function closeTab(root: WorkspaceNode, groupId: string, tabId: string): WorkspaceNode {
  const updated = updateGroup(root, groupId, (target) => removeTabFromGroup(target, tabId).group)
  return collapseEmptied(updated, groupId)
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
  without = collapseEmptied(without, source.group.id, targetGroupId)
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
  // No `keep` here: the target pane is in the other view's tree, so this pass
  // cannot reach it.
  const without = collapseEmptied(
    updateGroup(source.root, lifted.group.id, (item) => removeTabFromGroup(item, tabId).group),
    lifted.group.id
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

/** Arrange a view's tabs into the shape a layout describes.
 *
 *  Nothing is created and nothing is destroyed: the tabs that come out are the
 *  tabs that went in, in different places. That is what makes applying a
 *  layout safe while a terminal is running or a page is loaded — they are the
 *  same tabs, so their shell and their page carry over untouched.
 *
 *  A shape with more panes than you have tabs for leaves the extra ones empty,
 *  ready to be dragged into. One with fewer empties the remainder into the last
 *  pane, so applying a smaller grid never loses anything. */
export function arrangeInto(layout: Layout, view: WorkspaceView): WorkspaceView {
  // Pane by pane, in order. Tabs that shared a pane stay together, and a pane
  // that has nowhere to go in the new shape empties into the last one rather
  // than being dropped — a layout must not close a running terminal because it
  // asked for fewer panes than you had.
  const existing = walkGroups(view.root).map((group) => group.tabs)

  const fill = (node: WorkspaceNode): WorkspaceNode => {
    if (node.type === 'split') {
      return { ...node, id: workspaceId('split'), first: fill(node.first), second: fill(node.second) }
    }
    const tabs = existing.shift() ?? []
    return { id: workspaceId('group'), type: 'group', tabs, activeTabId: tabs[0]?.id ?? null }
  }

  const root = fill(layout.root)
  const groups = walkGroups(root)

  // Panes the shape had no room for. Safe to mutate: fill built these a moment
  // ago, and nothing else holds them yet.
  const last = groups[groups.length - 1]
  for (const tabs of existing) {
    last.tabs.push(...tabs)
    last.activeTabId ??= tabs[0]?.id ?? null
  }

  const focused = groups.find((group) => group.id === view.focusedGroupId) ?? groups[0]
  return { ...view, root, focusedGroupId: focused.id }
}

export function layoutFromView(workspace: WorkspaceView, name: string): Layout {
  return {
    id: workspaceId('layout'),
    name: name.trim() || 'Untitled layout',
    root: cloneLayout(workspace.root, true)
  }
}

/**
 * The list after a project row is dropped on another one.
 *
 * `before` decides which side of the target the row lands on, so a drag onto
 * the top half of a row puts the project above it and the bottom half below.
 * Returns the input untouched when the move changes nothing, which lets the
 * caller skip a write and a repaint.
 */
export function reorderPaths(paths: string[], moved: string, target: string, before: boolean): string[] {
  if (moved === target) return paths
  const from = paths.indexOf(moved)
  const at = paths.indexOf(target)
  if (from < 0 || at < 0) return paths
  const without = paths.filter((path) => path !== moved)
  // Locate the target again: removing the moved row shifts everything after it.
  const insert = without.indexOf(target) + (before ? 0 : 1)
  const next = [...without.slice(0, insert), moved, ...without.slice(insert)]
  return next.every((path, index) => path === paths[index]) ? paths : next
}
