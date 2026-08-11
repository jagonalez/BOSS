import type {
  DropPosition,
  LayoutTemplate,
  ProjectWorkspace,
  SplitDirection,
  WorkspaceGroup,
  WorkspaceNode,
  WorkspaceTab,
  WorkspaceTabKind
} from '@shared/workspace'

const WORKSPACES_KEY = 'ralf.projectWorkspaces.v2'
const TEMPLATES_KEY = 'ralf.layoutTemplates.v2'
let sequence = 0

export function workspaceId(prefix: string): string {
  sequence += 1
  return `${prefix}-${Date.now().toString(36)}-${sequence.toString(36)}`
}

export function tab(kind: WorkspaceTabKind, sessionId?: string): WorkspaceTab {
  return { id: workspaceId('tab'), kind, sessionId }
}

export function group(tabs: WorkspaceTab[] = []): WorkspaceGroup {
  return { id: workspaceId('group'), type: 'group', tabs, activeTabId: tabs[0]?.id ?? null }
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
  return tab(item.kind, stripBindings ? undefined : item.sessionId)
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

export function saveWorkspace(workspace: ProjectWorkspace): void {
  const all = readJson<Record<string, ProjectWorkspace>>(WORKSPACES_KEY, {})
  all[workspace.projectKey] = { ...workspace, updatedAt: Date.now() }
  writeJson(WORKSPACES_KEY, all)
}

export function loadWorkspace(projectKey: string, sessionId?: string): ProjectWorkspace {
  const saved = readJson<Record<string, ProjectWorkspace>>(WORKSPACES_KEY, {})[projectKey]
  if (saved?.version === 2 && isNode(saved.root)) return saved
  const root = group(sessionId ? [tab('thread', sessionId)] : [])
  return { version: 2, projectKey, root, focusedGroupId: root.id, updatedAt: Date.now() }
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

export function bindTemplate(template: LayoutTemplate, projectKey: string, sessionIds: string[]): ProjectWorkspace {
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
    }).map((item) => item.kind === 'thread' ? { ...item, sessionId: sessionIds[sessionIndex++] } : item)
    return { ...node, tabs, activeTabId: tabs[0]?.id ?? null }
  }
  const bound = bind(root)
  const first = walkGroups(bound)[0]
  return { version: 2, projectKey, root: bound, focusedGroupId: first.id, updatedAt: Date.now() }
}

export function templateFromWorkspace(workspace: ProjectWorkspace, name: string): LayoutTemplate {
  return {
    id: workspaceId('format'),
    name: name.trim() || 'Untitled format',
    favorite: true,
    root: cloneLayout(workspace.root, true)
  }
}
