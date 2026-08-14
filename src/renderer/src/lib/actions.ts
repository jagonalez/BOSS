import { appStore, type Attachment } from '../state/AppState'
import { OpenCode, isHighVariant, providerModels } from './opencode'
import { errorSummary } from './errors'
import { disposeTerminalSession } from './terminal-sessions'
import { startMicCapture } from './mic'
import type { Project, ReviewRun, SessionMeta } from '@shared/opencode'
import type { BackendId, BackendModeId, BackendModelDescriptor, BackendModelPreference, DelegatePlacement, ThreadCreationScope } from '@shared/backend'
import type { CollaborationPolicy } from '@shared/thread-bus'
import type { QaPolicy } from '@shared/qa'
import type { AutomationsSnapshot } from '@shared/automation'
import type { AsrStatus, TtsStatus } from '@shared/speech'
import type { AppPage, DropPosition, SplitDirection, TerminalStartLocation, WorkspaceCheckoutBinding, WorkspaceTabKind, WorkspaceView } from '@shared/workspace'
import {
  activeWorkspaceView,
  activateTab,
  addTab,
  bindTemplate,
  closeGroup,
  closeTab,
  findGroup,
  findSessionTab,
  findTab,
  loadTemplates,
  loadWorkspace,
  mapTabs,
  moveTabAcrossViews,
  nextWorkspaceViewName,
  reorderTab,
  resizeSplit,
  saveCustomTemplates,
  saveWorkspace,
  splitGroup,
  tab,
  templateFromWorkspace,
  updateActiveWorkspaceView,
  updateGroup,
  walkGroups,
  walkTabs,
  workspaceView
} from './workspaces'

export function initializeWorkspaceState(): void {
  let terminalStartLocation: TerminalStartLocation = 'focused-checkout'
  try {
    if (localStorage.getItem('boss.terminalStartLocation') === 'project-root') terminalStartLocation = 'project-root'
  } catch {
    /* Retain the focused-checkout default. */
  }
  appStore.setState({ layoutTemplates: loadTemplates(), terminalStartLocation })
}

export function setTerminalStartLocation(value: TerminalStartLocation): void {
  appStore.setState({ terminalStartLocation: value })
  try {
    localStorage.setItem('boss.terminalStartLocation', value)
  } catch {
    /* The in-memory setting still applies for this run. */
  }
}

export function showPage(page: AppPage): void {
  appStore.setState({ activePage: page })
}

export function setNativeViewsSuspended(reason: string, suspended: boolean): void {
  appStore.setState((state) => {
    const reasons = new Set(state.nativeViewSuspensions)
    if (suspended) reasons.add(reason)
    else reasons.delete(reason)
    return { nativeViewSuspensions: [...reasons] }
  })
}

/** Load the app's views. Call once at startup: they are not per project, so
 *  opening a project must not reload them. */
export function loadProjectWorkspace(preferredSessionId?: string): void {
  if (appStore.getState().projectWorkspace) return
  appStore.setState({ projectWorkspace: loadWorkspace(preferredSessionId) })
}

export function createWorkspaceView(): void {
  const workspace = currentWorkspace()
  if (!workspace) return
  const created = workspaceView(nextWorkspaceViewName(workspace.views))
  updateWorkspace((item) => ({
    ...item,
    views: [...item.views, created],
    activeViewId: created.id
  }))
}

export function activateWorkspaceView(viewId: string): void {
  const workspace = currentWorkspace()
  if (!workspace?.views.some((view) => view.id === viewId) || workspace.activeViewId === viewId) return
  const next = updateWorkspace((item) => ({ ...item, activeViewId: viewId }))
  if (next) syncFocusedThread()
}

export function renameWorkspaceView(viewId: string, name: string): void {
  const clean = name.trim()
  if (!clean) return
  updateWorkspace((item) => ({
    ...item,
    views: item.views.map((view) => view.id === viewId ? { ...view, name: clean } : view)
  }))
}

export function closeWorkspaceView(viewId: string): void {
  const workspace = currentWorkspace()
  if (!workspace || workspace.views.length <= 1) return
  const index = workspace.views.findIndex((view) => view.id === viewId)
  if (index < 0) return
  const views = workspace.views.filter((view) => view.id !== viewId)
  const activeViewId = workspace.activeViewId === viewId
    ? (views[index] ?? views[index - 1] ?? views[0]).id
    : workspace.activeViewId
  const next = updateWorkspace((item) => ({ ...item, views, activeViewId }))
  if (next) syncFocusedThread()
}

function updateWorkspace(
  update: (workspace: NonNullable<ReturnType<typeof currentWorkspace>>) => NonNullable<ReturnType<typeof currentWorkspace>>
): NonNullable<ReturnType<typeof currentWorkspace>> | null {
  const current = currentWorkspace()
  if (!current) return null
  const next = { ...update(current), updatedAt: Date.now() }
  saveWorkspace(next)
  appStore.setState({ projectWorkspace: next })
  return next
}

function currentWorkspace() {
  return appStore.getState().projectWorkspace
}

function currentView() {
  const workspace = currentWorkspace()
  return workspace ? activeWorkspaceView(workspace) : null
}

function updateWorkspaceView(update: (view: NonNullable<ReturnType<typeof currentView>>) => NonNullable<ReturnType<typeof currentView>>) {
  return updateWorkspace((workspace) => updateActiveWorkspaceView(workspace, update))
}

function activeTabInFocusedGroup() {
  const workspace = currentWorkspace()
  if (!workspace) return undefined
  const view = activeWorkspaceView(workspace)
  const target = findGroup(view.root, view.focusedGroupId)
  return target?.tabs.find((item) => item.id === target.activeTabId)
}

function syncFocusedThread(): void {
  const active = activeTabInFocusedGroup()
  if (active?.kind === 'thread' && active.sessionId) selectSession(active.sessionId, false)
}

export function focusWorkspaceGroup(groupId: string): void {
  const workspace = currentWorkspace()
  if (!workspace) return
  const view = activeWorkspaceView(workspace)
  if (!findGroup(view.root, groupId)) return
  if (view.focusedGroupId !== groupId) updateWorkspaceView((item) => ({ ...item, focusedGroupId: groupId }))
  syncFocusedThread()
}

export function activateWorkspaceTab(groupId: string, tabId: string): void {
  const next = updateWorkspaceView((item) => ({
    ...item,
    root: activateTab(item.root, groupId, tabId),
    focusedGroupId: groupId
  }))
  const active = next ? findTab(activeWorkspaceView(next).root, tabId)?.tab : undefined
  if (active?.kind === 'thread' && active.sessionId) selectSession(active.sessionId, false)
}

export function addWorkspaceTab(
  groupId: string,
  kind: WorkspaceTabKind,
  sessionId?: string,
  checkout?: WorkspaceCheckoutBinding
): void {
  const workspace = currentWorkspace()
  if (!workspace) return
  const view = activeWorkspaceView(workspace)
  if (kind === 'thread' && sessionId) {
    const existing = findSessionTab(view.root, sessionId)
    if (existing) {
      activateWorkspaceTab(existing.group.id, existing.tab.id)
      return
    }
  }
  if (kind === 'review' || kind === 'files') {
    // Deduped by checkout, not by owning thread. Two threads on one checkout
    // see the same files and the same diff, so a second tab would be a copy of
    // the first. The owner is still recorded on the tab for the sidebar.
    const existing = walkTabs(view.root).find((item) =>
      item.kind === kind && item.contextPath === checkout?.contextPath
    )
    if (existing) {
      const location = findTab(view.root, existing.id)
      if (location) activateWorkspaceTab(location.group.id, existing.id)
      return
    }
  }
  const created = tab(kind, sessionId, checkout)
  updateWorkspaceView((item) => ({
    ...item,
    root: addTab(item.root, groupId, created),
    focusedGroupId: groupId
  }))
  if (kind === 'thread' && sessionId) selectSession(sessionId, false)
}

export function openBackendLogin(backendId: BackendId): void {
  let workspace = currentWorkspace()
  if (!workspace) {
    workspace = loadWorkspace()
    appStore.setState({ projectWorkspace: workspace })
  }
  const view = activeWorkspaceView(workspace)
  const groupId = findGroup(view.root, view.focusedGroupId)?.id ?? walkGroups(view.root)[0].id
  const contextPath = appStore.getState().projectPath
  const created = tab('terminal', undefined, contextPath ? { contextPath, contextLabel: 'Main' } : undefined)
  updateWorkspaceView((item) => ({
    ...item,
    root: addTab(item.root, groupId, created),
    focusedGroupId: groupId
  }))
  appStore.setState((state) => ({
    authTerminalBackends: { ...(state.authTerminalBackends ?? {}), [created.id]: backendId },
    settingsOpen: false,
    activePage: 'project'
  }))
}

export async function refreshBackendAuth(): Promise<void> {
  try {
    appStore.setState({ backendAuth: await OpenCode.backendAuthStatus() })
  } catch {
    /* Individual backend availability is already shown in Settings. */
  }
}

export async function refreshBackendModels(): Promise<void> {
  const backends = appStore.getState().backends
  appStore.setState({ backendModelsLoading: true })
  const entries = await Promise.all(backends.map(async (backend): Promise<[BackendId, BackendModelDescriptor[]]> => {
    if (!backend.available) return [backend.id, []]
    try {
      if (backend.id === 'opencode') {
        const { all, connected } = await OpenCode.providers()
        const connectedSet = await connectedProviderIds(connected)
        const providers = (all ?? []).filter((provider) => connectedSet.size === 0 || connectedSet.has(provider.id))
        return [backend.id, providers.flatMap((provider) => providerModels(provider).map((model) => ({
          id: model.id,
          name: model.name,
          provider: provider.id,
          variants: model.variants
        })))]
      }
      return [backend.id, await OpenCode.backendModels(undefined, backend.id)]
    } catch {
      return [backend.id, []]
    }
  }))
  appStore.setState({ backendModels: Object.fromEntries(entries), backendModelsLoading: false })
}

export function setDefaultModel(backendId: BackendId, model: BackendModelDescriptor | null): void {
  appStore.setState((state) => {
    const defaultModels = { ...(state.defaultModels ?? {}) }
    if (model) {
      defaultModels[backendId] = { modelID: model.id, providerID: model.provider || backendId }
    } else {
      delete defaultModels[backendId]
    }
    persistThreadPreference('boss.defaultModels', defaultModels)
    void OpenCode.setBackendDefaults(defaultModels).catch(() => {})
    return { defaultModels }
  })
}

function applyBackendDefaultModel(sessionId: string, backendId: BackendId): void {
  const preference = appStore.getState().defaultModels?.[backendId]
  if (preference) setModel(preference.modelID, sessionId, preference.providerID)
}

function copyThreadModelPreference(sourceId: string, targetId: string): void {
  const state = appStore.getState()
  const source = state.sessions.find((session) => session.id === sourceId)
  const modelID = state.modelsBySession[sourceId] ?? source?.model?.id
  const providerID = state.modelProvidersBySession?.[sourceId] ?? source?.model?.provider
  if (!modelID) return
  setModel(modelID, targetId, providerID)
  if (Object.prototype.hasOwnProperty.call(state.variantsBySession, sourceId)) {
    setVariant(state.variantsBySession[sourceId], targetId)
  }
}

export async function createThreadInGroup(groupId: string, backendId: BackendId = appStore.getState().engine): Promise<void> {
  try {
    const session = await OpenCode.createSession(undefined, backendId)
    applyBackendDefaultModel(session.id, backendId)
    upsertSessionMeta(session.id, { kind: 'main', projectPath: session.projectPath ?? appStore.getState().projectPath })
    await refreshSessions()
    const defaultMode = appStore.getState().backends.find((backend) => backend.id === backendId)?.modes[0]?.id ?? 'ask'
    setMode(defaultMode, session.id)
    await refreshProviders(session.id)
    addWorkspaceTab(groupId, 'thread', session.id)
  } catch {
    /* ignore */
  }
}

export function splitWorkspaceGroup(groupId: string, direction: SplitDirection): void {
  updateWorkspaceView((item) => {
    const result = splitGroup(item.root, groupId, direction)
    return { ...item, root: result.root, focusedGroupId: result.groupId }
  })
}

/** Put back the views as they were before the last close.
 *
 *  Closing disposes what it removes, so a misdrag or a slipped click would
 *  otherwise cost a running terminal. The snapshot holds the whole view list,
 *  which is what makes restoring a closed pane the same operation as
 *  restoring a closed tab. */
let closeUndo: { views: WorkspaceView[]; activeViewId: string; label: string } | null = null
let closeUndoTimer: number | undefined

export function undoWorkspaceClose(): void {
  const snapshot = closeUndo
  if (!snapshot) return
  closeUndo = null
  window.clearTimeout(closeUndoTimer)
  updateWorkspace((item) => ({ ...item, views: snapshot.views, activeViewId: snapshot.activeViewId }))
  appStore.setState({ workspaceUndo: null })
  syncFocusedThread()
}

function rememberClose(label: string): void {
  const workspace = currentWorkspace()
  if (!workspace) return
  closeUndo = { views: workspace.views, activeViewId: workspace.activeViewId, label }
  appStore.setState({ workspaceUndo: { label } })
  window.clearTimeout(closeUndoTimer)
  closeUndoTimer = window.setTimeout(() => {
    closeUndo = null
    appStore.setState({ workspaceUndo: null })
  }, 8_000)
}

export function closeWorkspaceTab(groupId: string, tabId: string): void {
  const view = currentView()
  const closing = view ? findTab(view.root, tabId)?.tab : undefined
  rememberClose(closing ? `Closed ${closing.kind}` : 'Closed tab')
  // Live surfaces are disposed here rather than when their component unmounts.
  // React unmounts one whenever its tab moves, and StrictMode unmounts
  // everything once on purpose, so tying disposal to unmounting destroyed
  // pages and shells that were only being re-parented.
  if (closing?.kind === 'browser') void window.boss.browseDestroy(`workspace-${tabId}`)
  if (closing?.kind === 'terminal') disposeTerminalSession(tabId)
  const next = updateWorkspaceView((item) => {
    const root = closeTab(item.root, groupId, tabId)
    const focusedGroupId = findGroup(root, item.focusedGroupId)?.id ?? walkGroups(root)[0].id
    return { ...item, root, focusedGroupId }
  })
  appStore.setState((state) => {
    const authTerminalBackends = { ...(state.authTerminalBackends ?? {}) }
    delete authTerminalBackends[tabId]
    return { authTerminalBackends }
  })
  if (next) syncFocusedThread()
}

export function closeWorkspaceGroup(groupId: string): void {
  rememberClose('Closed pane')
  const view = currentView()
  const pane = view ? findGroup(view.root, groupId) : undefined
  for (const item of pane?.tabs ?? []) {
    if (item.kind === 'browser') void window.boss.browseDestroy(`workspace-${item.id}`)
    if (item.kind === 'terminal') disposeTerminalSession(item.id)
  }
  const next = updateWorkspaceView((item) => {
    const root = closeGroup(item.root, groupId)
    return { ...item, root, focusedGroupId: walkGroups(root)[0].id }
  })
  if (next) syncFocusedThread()
}

export function setWorkspaceSplitRatio(splitId: string, ratio: number): void {
  updateWorkspaceView((item) => ({ ...item, root: resizeSplit(item.root, splitId, ratio) }))
}

export function reorderWorkspaceTab(groupId: string, tabId: string, beforeTabId?: string): void {
  updateWorkspaceView((item) => ({ ...item, root: reorderTab(item.root, groupId, tabId, beforeTabId) }))
}

export function openSessionInWorkspace(sessionId: string): boolean {
  const workspace = currentWorkspace()
  if (!workspace) return false
  const view = activeWorkspaceView(workspace)
  const existing = findSessionTab(view.root, sessionId)
  if (existing) {
    activateWorkspaceTab(existing.group.id, existing.tab.id)
    return true
  }
  const groupId = findGroup(view.root, view.focusedGroupId)?.id ?? walkGroups(view.root)[0].id
  addWorkspaceTab(groupId, 'thread', sessionId)
  return true
}

/** Move a resource into a group in any view, then go and show it there.
 *  Dropping something you dragged out of the sidebar is worth following: it may
 *  land in a view you were not looking at, and a silent move looks like a
 *  failed one. */
export function sendWorkspaceTabToView(
  tabId: string,
  targetViewId: string,
  targetGroupId: string,
  position: DropPosition = 'center'
): void {
  const workspace = currentWorkspace()
  if (!workspace) return
  const views = moveTabAcrossViews(workspace.views, tabId, targetViewId, targetGroupId, position)
  if (views === workspace.views) return
  updateWorkspace((item) => ({ ...item, views, activeViewId: targetViewId }))
  const landed = views.find((view) => view.id === targetViewId)
  const group = landed ? walkGroups(landed.root).find((item) => item.tabs.some((entry) => entry.id === tabId)) : undefined
  if (group) activateWorkspaceTab(group.id, tabId)
  highlightWorkspaceTab(tabId)
  showPage('project')
}

/** Put a thread in the pane it was dropped on.
 *
 *  A thread already on screen moves, so dropping it twice does not open two
 *  copies. One that is not open yet gets a tab created where it landed, which
 *  is what makes an empty pane fillable by dragging rather than by a picker. */
export function dropSessionInGroup(
  sessionId: string,
  targetViewId: string,
  targetGroupId: string,
  position: DropPosition = 'center'
): void {
  const workspace = currentWorkspace()
  if (!workspace) return

  for (const view of workspace.views) {
    const existing = findSessionTab(view.root, sessionId)
    if (existing) {
      sendWorkspaceTabToView(existing.tab.id, targetViewId, targetGroupId, position)
      return
    }
  }

  const target = workspace.views.find((view) => view.id === targetViewId)
  if (!target || !findGroup(target.root, targetGroupId)) return
  const created = tab('thread', sessionId)
  updateWorkspace((item) => ({
    ...item,
    activeViewId: targetViewId,
    views: item.views.map((view) =>
      view.id === targetViewId
        ? { ...view, root: addTab(view.root, targetGroupId, created), focusedGroupId: targetGroupId }
        : view
    )
  }))
  activateWorkspaceTab(targetGroupId, created.id)
  highlightWorkspaceTab(created.id)
  showPage('project')
}

/** Give a thread a resource, from the sidebar rather than from its pane.
 *
 *  The resource takes the thread's checkout, so there is nothing to choose.
 *  A thread that is not on screen opens first: adding a terminal to a thread
 *  you cannot see should still show you the terminal. */
export function addResourceToSession(sessionId: string, kind: WorkspaceTabKind): void {
  const workspace = currentWorkspace()
  if (!workspace) return

  let placement: { viewId: string; groupId: string } | undefined
  for (const view of workspace.views) {
    const found = findSessionTab(view.root, sessionId)
    if (found) {
      placement = { viewId: view.id, groupId: found.group.id }
      break
    }
  }

  if (!placement) {
    const view = activeWorkspaceView(workspace)
    const groupId = findGroup(view.root, view.focusedGroupId)?.id ?? walkGroups(view.root)[0].id
    dropSessionInGroup(sessionId, view.id, groupId)
    placement = { viewId: view.id, groupId }
  } else if (workspace.activeViewId !== placement.viewId) {
    activateWorkspaceView(placement.viewId)
  }

  const session = appStore.getState().sessions.find((item) => item.id === sessionId)
  const path = session?.executionPath ?? session?.worktree?.path ?? session?.projectPath
    ?? session?.directory ?? session?.path ?? appStore.getState().projectPath
  const checkout: WorkspaceCheckoutBinding | undefined = path
    ? { contextPath: path, worktreeId: session?.worktree?.id, contextLabel: session?.worktree?.branch ?? 'Main' }
    : undefined

  addWorkspaceTab(placement.groupId, kind, sessionId, checkout)
  showPage('project')
}

/** Name a resource. Blank clears it, so the tab falls back to its kind.
 *  Two terminals on one thread are otherwise both called "Terminal". */
export function renameWorkspaceTab(tabId: string, title: string): void {
  const clean = title.trim()
  updateWorkspace((workspace) => ({
    ...workspace,
    views: workspace.views.map((view) => ({
      ...view,
      root: mapTabs(view.root, (item) =>
        item.id === tabId ? { ...item, title: clean || undefined } : item
      )
    }))
  }))
}

/** Flash a tab that just arrived, so the eye finds it without hunting. */
export function highlightWorkspaceTab(tabId: string): void {
  appStore.setState({ highlightedTabId: tabId })
  window.setTimeout(() => {
    if (appStore.getState().highlightedTabId === tabId) appStore.setState({ highlightedTabId: undefined })
  }, 1_400)
}

/** Jump to wherever a tab currently is: switch views if needed, then focus it.
 *  Selection runs both ways, so a row in the sidebar reaches its resource even
 *  after the resource was dragged into a view of its own. */
export function revealWorkspaceTab(viewId: string, groupId: string, tabId: string): void {
  const workspace = currentWorkspace()
  if (!workspace?.views.some((view) => view.id === viewId)) return
  if (workspace.activeViewId !== viewId) activateWorkspaceView(viewId)
  activateWorkspaceTab(groupId, tabId)
  showPage('project')
}

export function applyLayoutTemplate(templateId: string): void {
  const state = appStore.getState()
  const workspace = state.projectWorkspace
  const template = state.layoutTemplates.find((item) => item.id === templateId)
  if (!workspace || !template) return
  const view = activeWorkspaceView(workspace)
  const focusedGroup = findGroup(view.root, view.focusedGroupId)
  const focusedTab = focusedGroup?.tabs.find((item) => item.id === focusedGroup.activeTabId)
  const focused = focusedTab?.kind === 'thread' ? focusedTab.sessionId : undefined
  const sessions = [focused, ...state.sessions.map((item) => item.id)].filter(
    (id, index, all): id is string => Boolean(id) && all.indexOf(id) === index
  )
  const activeSession = state.sessions.find((item) => item.id === (focused ?? state.activeSessionId))
  const useFocused = state.terminalStartLocation === 'focused-checkout'
  const contextPath = useFocused
    ? activeSession?.executionPath ?? activeSession?.worktree?.path ?? state.projectPath
    : state.projectPath
  const checkout: WorkspaceCheckoutBinding | undefined = contextPath
    ? {
        contextPath,
        worktreeId: useFocused ? activeSession?.worktree?.id : undefined,
        contextLabel: useFocused && activeSession?.worktree?.branch ? activeSession.worktree.branch : 'Main'
      }
    : undefined
  const nextView = bindTemplate(template, view.name, sessions, checkout)
  const next = updateActiveWorkspaceView(workspace, () => ({ ...nextView, id: view.id, name: view.name }))
  saveWorkspace(next)
  appStore.setState({ projectWorkspace: next })
  const firstThread = walkTabs(activeWorkspaceView(next).root).find((item) => item.kind === 'thread' && item.sessionId)
  if (firstThread?.sessionId) selectSession(firstThread.sessionId, false)
}

export function saveCurrentLayoutTemplate(name: string): void {
  const state = appStore.getState()
  if (!state.projectWorkspace) return
  const template = templateFromWorkspace(activeWorkspaceView(state.projectWorkspace), name)
  const templates = [...state.layoutTemplates, template]
  saveCustomTemplates(templates)
  appStore.setState({ layoutTemplates: templates })
}

export function removeLayoutTemplate(templateId: string): void {
  const state = appStore.getState()
  const target = state.layoutTemplates.find((item) => item.id === templateId)
  if (!target || target.builtIn) return
  const templates = state.layoutTemplates.filter((item) => item.id !== templateId)
  saveCustomTemplates(templates)
  appStore.setState({ layoutTemplates: templates })
}
function persistSessionMeta(meta: Record<string, SessionMeta>): void {
  try {
    localStorage.setItem('boss.sessionMeta', JSON.stringify(meta))
  } catch {
    /* ignore */
  }
}

export function loadSessionMeta(): void {
  try {
    const parsed = JSON.parse(localStorage.getItem('boss.sessionMeta') ?? '{}')
    if (parsed && typeof parsed === 'object') appStore.setState({ sessionMeta: parsed })
  } catch {
    /* ignore */
  }
}

export function upsertSessionMeta(sessionId: string, patch: Partial<SessionMeta>): void {
  appStore.setState((s) => {
    const meta = { ...s.sessionMeta }
    const cur = meta[sessionId] ?? { sessionId, kind: 'main', reviews: [] }
    meta[sessionId] = { ...cur, ...patch }
    persistSessionMeta(meta)
    return { sessionMeta: meta }
  })
}

export function setAttention(kind: 'permission' | 'done' | 'error'): void {
  appStore.setState({ attention: { kind, ts: Date.now() } })
}

export function clearAttention(): void {
  if (appStore.getState().attention) appStore.setState({ attention: null })
}

export function loadChatOrder(): void {
  try {
    const parsed = JSON.parse(localStorage.getItem('boss.chatOrder') ?? '[]')
    if (Array.isArray(parsed)) appStore.setState({ chatOrder: parsed.filter((x) => typeof x === 'string') })
  } catch {
    /* ignore */
  }
}

export function setChatOrder(ids: string[]): void {
  appStore.setState({ chatOrder: ids })
  try {
    localStorage.setItem('boss.chatOrder', JSON.stringify(ids))
  } catch {
    /* ignore */
  }
}

export function setLauncherProject(path: string | null): void {
  appStore.setState({ launcherProject: path })
}

async function ensureProject(path: string | null): Promise<void> {
  if (!path) return
  const cur = appStore.getState()
  if (cur.projectPath === path) return
  try {
    const info = await window.boss.projectSet(path)
    appStore.setState({
      projectPath: info.path,
      selectedCheckoutPath: info.checkoutPath,
      projectCheckouts: info.checkouts
    })
    await refreshSessions()
    await refreshProjects()
  } catch {
    /* ignore */
  }
}

export async function newChatWithPrompt(prompt: string, attachments?: Attachment[]): Promise<void> {
  const project = appStore.getState().launcherProject
  await ensureProject(project)
  await createSession(project ? 'current' : 'global')
  const id = appStore.getState().activeSessionId
  if (id) await sendPrompt(prompt, id, attachments)
}

export function sessionMetaFor(sessionId: string): SessionMeta | undefined {
  return appStore.getState().sessionMeta[sessionId]
}

export async function runThreadReview(sessionID: string, target: string, contextPath?: string): Promise<void> {
  const projectPath = contextPath || appStore.getState().projectPath
  let baseSha = ''
  try {
    const r = await window.boss.gitRun(projectPath, ['rev-parse', 'HEAD'])
    if (r.code === 0) baseSha = r.stdout.trim()
  } catch {
    /* ignore */
  }
  const review: ReviewRun = {
    id: `rev-${Date.now()}`,
    target,
    baseSha,
    findings: [],
    createdAt: Date.now(),
    stale: false
  }
  appStore.setState((s) => {
    const meta = { ...s.sessionMeta }
    const cur = meta[sessionID] ?? { sessionId: sessionID, kind: 'main', reviews: [] }
    meta[sessionID] = { ...cur, reviews: [...(cur.reviews ?? []), review] }
    persistSessionMeta(meta)
    return { sessionMeta: meta }
  })
  const cur = appStore.getState()
  const model = modelForSession(sessionID)
  const mode = modeForSession(sessionID)
  const modelKey = model ? resolveModelKey(model, sessionID) : undefined
  const agent = mode === 'plan' ? 'plan' : cur.agent || 'build'
  const parts = [
    {
      type: 'text',
      text: `Review the current ${target} changes. Report findings as a concise, prioritized list of issues (bugs, security, performance, style) with file references where possible.`
    }
  ]
  try {
    noteThreadSend(sessionID)
    await OpenCode.sendMessageAsync(sessionID, parts, { model: modelKey, agent, mode })
  } catch (err) {
    setSessionError(sessionID, errorSummary(err))
  }
  await loadMessages(sessionID)
}

export async function runCheckoutReview(
  groupId: string,
  reviewTabId: string,
  target: string,
  contextPath: string,
  existingSessionId?: string
): Promise<void> {
  const state = appStore.getState()
  const existing = existingSessionId
    ? state.sessions.find((session) => session.id === existingSessionId && (session.executionPath ?? session.worktree?.path) === contextPath)
    : undefined
  let session = existing
  if (!session) {
    const backendId = state.engine
    const title = `Review · ${target}`
    session = await OpenCode.createSessionInPath(contextPath, title, backendId)
    applyBackendDefaultModel(session.id, backendId)
    upsertSessionMeta(session.id, { kind: 'main', projectPath: session.projectPath ?? state.projectPath })
    await refreshSessions()
    const defaultMode = appStore.getState().backends.find((backend) => backend.id === backendId)?.modes[0]?.id ?? 'ask'
    setMode(defaultMode, session.id)
    await refreshProviders(session.id)
    updateWorkspaceView((view) => ({
      ...view,
      root: updateGroup(view.root, groupId, (group) => ({
        ...group,
        tabs: group.tabs.map((item) => item.id === reviewTabId ? { ...item, sessionId: session!.id } : item)
      }))
    }))
  }
  addWorkspaceTab(groupId, 'thread', session.id)
  await runThreadReview(session.id, target, contextPath)
}

export function markStaleReviews(sessionID: string, contextPath?: string): void {
  const projectPath = contextPath || appStore.getState().projectPath
  void (async () => {
    let head = ''
    try {
      const r = await window.boss.gitRun(projectPath, ['rev-parse', 'HEAD'])
      if (r.code === 0) head = r.stdout.trim()
    } catch {
      /* ignore */
    }
    if (!head) return
    appStore.setState((s) => {
      const meta = s.sessionMeta[sessionID]
      if (!meta) return {}
      const reviews = meta.reviews.map((r) => (r.baseSha && r.baseSha !== head ? { ...r, stale: true } : r))
      if (!reviews.some((r, i) => r.stale !== meta.reviews[i].stale)) return {}
      const next = { ...s.sessionMeta, [sessionID]: { ...meta, reviews } }
      persistSessionMeta(next)
      return { sessionMeta: next }
    })
  })()
}

export async function refreshSessions(): Promise<void> {
  try {
    appStore.setState({ sessions: await OpenCode.listSessions() })
  } catch {
    /* ignore */
  }
}

export async function refreshFollowUps(threadId: string): Promise<void> {
  try {
    const followUps = await OpenCode.followUps(threadId)
    appStore.setState((state) => ({ followUps: { ...state.followUps, [threadId]: followUps } }))
  } catch {
    /* The thread may have been removed while its view was still closing. */
  }
}

export async function refreshThreadBus(threadId?: string): Promise<void> {
  try {
    appStore.setState({ threadBus: await OpenCode.threadBus(threadId) })
  } catch {
    /* Thread bus may still be starting during the first renderer refresh. */
  }
}

export async function refreshMcpConnections(): Promise<void> {
  try {
    appStore.setState({ mcpConnections: await OpenCode.mcpList() })
  } catch {
    /* MCP connections may still be starting during the first renderer refresh. */
  }
}

/**
 * Automation threads are created in the main process, so the renderer's
 * per-thread mode and model maps never see them. Backfill both so the thread
 * UI shows what the run actually uses.
 */
export function syncAutomationThreadPreferences(snapshot: AutomationsSnapshot | null): void {
  if (!snapshot) return
  const state = appStore.getState()
  const automations = new Map(snapshot.automations.map((automation) => [automation.id, automation]))
  for (const run of snapshot.runs) {
    if (!run.threadId) continue
    const automation = automations.get(run.automationId)
    if (!automation) continue
    if (!state.modesBySession[run.threadId]) setMode(automation.mode, run.threadId)
    if (automation.model && !state.modelsBySession[run.threadId]) {
      setModel(automation.model.modelID, run.threadId, automation.model.providerID)
    }
  }
}

export async function refreshAutomations(): Promise<void> {
  try {
    const snapshot = await OpenCode.automationsList()
    appStore.setState({ automations: snapshot })
    syncAutomationThreadPreferences(snapshot)
  } catch {
    /* Automations may still be starting during the first renderer refresh. */
  }
}

export async function setThreadBusPolicy(policy: CollaborationPolicy): Promise<void> {
  try {
    appStore.setState({ threadBus: await OpenCode.setThreadBusPolicy(policy) })
  } catch (error) {
    appStore.setState({ lastError: errorSummary(error) })
  }
}

export async function clearThreadBusFailures(): Promise<void> {
  try {
    appStore.setState({ threadBus: await OpenCode.clearThreadBusFailures() })
  } catch (error) {
    appStore.setState({ lastError: errorSummary(error) })
  }
}

export async function refreshProjects(): Promise<void> {
  try {
    // BOSS owns the project list. opencode only knows a directory once it has
    // served a session there, so sourcing the list from it hid freshly opened
    // projects and emptied the sidebar whenever opencode was not running.
    // A backend's own projects are offered for import, never merged silently.
    const owned = await window.boss.projectList().catch((): string[] => [])
    const listed: Project[] = owned.map((path) => ({ id: path, path }))
    const state = appStore.getState()
    const checkoutPaths = new Set(state.projectCheckouts.map((checkout) => checkout.path))
    const projects = listed.map((project) => {
      const path = project.worktree ?? project.directory ?? project.path ?? ''
      return path && checkoutPaths.has(path) && state.projectPath
        ? { ...project, path: state.projectPath, directory: undefined, worktree: undefined }
        : project
    }).filter((project, index, all) => {
      const path = project.worktree ?? project.directory ?? project.path ?? ''
      return all.findIndex((candidate) => (candidate.worktree ?? candidate.directory ?? candidate.path ?? '') === path) === index
    })
    appStore.setState({ projects })
  } catch {
    /* ignore */
  }
}

/**
 * Providers configured in the opencode config file (provider: { openrouter: … })
 * may not appear in the /provider "connected" list, which reflects
 * credential-store logins — union them in so their models stay visible.
 */
async function connectedProviderIds(connected: string[] | undefined): Promise<Set<string>> {
  const ids = new Set(connected ?? [])
  let config = appStore.getState().config
  if (!config) {
    try {
      config = await OpenCode.config()
      appStore.setState({ config })
    } catch {
      return ids
    }
  }
  const provider = (config as { provider?: unknown }).provider
  if (provider && typeof provider === 'object') {
    for (const key of Object.keys(provider as Record<string, unknown>)) ids.add(key)
  }
  return ids
}

export async function refreshProviders(sessionId?: string): Promise<void> {
  const state = appStore.getState()
  const id = sessionId ?? state.activeSessionId ?? undefined
  const backendId = state.sessions.find((session) => session.id === id)?.backendId ?? 'opencode'
  try {
    if (backendId !== 'opencode') {
      const models = await OpenCode.backendModels(id, backendId)
      const grouped = new Map<string, Array<{ id: string; name?: string; variants?: Record<string, object> }>>()
      for (const model of models) {
        const provider = model.provider || backendId
        const variants = model.variants?.length
          ? Object.fromEntries(model.variants.map((variant) => [variant, {}]))
          : undefined
        grouped.set(provider, [...(grouped.get(provider) ?? []), { id: model.id, name: model.name, variants }])
      }
      const providers = [...grouped].map(([provider, entries]) => ({ id: provider, name: provider, models: entries }))
      appStore.setState((current) => id
        ? { providers: providers, providersBySession: { ...current.providersBySession, [id]: providers } }
        : { providers })
      resolveDefaultModel(id)
      return
    }
    const { all, connected } = await OpenCode.providers()
    const connectedSet = await connectedProviderIds(connected)
    const filtered = (all ?? []).filter((p) => connectedSet.has(p.id))
    const providers = filtered.length > 0 ? filtered : all ?? []
    appStore.setState((current) => id
      ? { providers, providersBySession: { ...current.providersBySession, [id]: providers } }
      : { providers })
    resolveDefaultModel(id)
  } catch {
    /* ignore */
  }
}

function persistThreadPreference(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* ignore */
  }
}

export function loadThreadPreferences(): void {
  try {
    const modelsBySession = JSON.parse(localStorage.getItem('boss.modelsBySession') ?? '{}') as Record<string, string>
    const modelProvidersBySession = JSON.parse(localStorage.getItem('boss.modelProvidersBySession') ?? '{}') as Record<string, string>
    const variantsBySession = JSON.parse(localStorage.getItem('boss.variantsBySession') ?? '{}') as Record<string, string | null>
    const modesBySession = JSON.parse(localStorage.getItem('boss.modesBySession') ?? '{}') as Record<string, BackendModeId>
    const defaultModels = JSON.parse(localStorage.getItem('boss.defaultModels') ?? '{}') as Partial<Record<BackendId, BackendModelPreference>>
    const modelProvider = localStorage.getItem('boss.modelProvider')
    appStore.setState({ modelsBySession, modelProvidersBySession, variantsBySession, modesBySession, defaultModels, modelProvider })
    void OpenCode.setBackendDefaults(defaultModels).catch(() => {})
  } catch {
    /* Ignore malformed preferences and retain safe defaults. */
  }
}

export function modelForSession(sessionId?: string): string | null {
  const state = appStore.getState()
  return (sessionId && state.modelsBySession[sessionId]) || state.model
}

export function modelProviderForSession(sessionId?: string): string | null {
  const state = appStore.getState()
  return (sessionId && state.modelProvidersBySession?.[sessionId]) || state.modelProvider
}

export function variantForSession(sessionId?: string): string | null {
  const state = appStore.getState()
  return sessionId && Object.prototype.hasOwnProperty.call(state.variantsBySession, sessionId)
    ? state.variantsBySession[sessionId]
    : state.variant
}

export function modeForSession(sessionId?: string): BackendModeId {
  const state = appStore.getState()
  const requested = (sessionId && state.modesBySession[sessionId]) || state.mode
  const backendId = sessionId ? state.sessions.find((session) => session.id === sessionId)?.backendId : state.engine
  const descriptor = state.backends.find((backend) => backend.id === backendId)
  return descriptor?.modes.some((mode) => mode.id === requested) ? requested : descriptor?.modes[0]?.id ?? requested
}

export function setModel(id: string, sessionId: string | null = appStore.getState().activeSessionId, providerID?: string): void {
  if (sessionId) {
    appStore.setState((state) => {
      const modelsBySession = { ...state.modelsBySession, [sessionId]: id }
      const modelProvidersBySession = { ...(state.modelProvidersBySession ?? {}) }
      if (providerID) modelProvidersBySession[sessionId] = providerID
      else delete modelProvidersBySession[sessionId]
      const variantsBySession = { ...state.variantsBySession, [sessionId]: null }
      persistThreadPreference('boss.modelsBySession', modelsBySession)
      persistThreadPreference('boss.modelProvidersBySession', modelProvidersBySession)
      persistThreadPreference('boss.variantsBySession', variantsBySession)
      return { modelsBySession, modelProvidersBySession, variantsBySession }
    })
    return
  }
  appStore.setState({ model: id, modelProvider: providerID ?? null, variant: null })
  try {
    localStorage.setItem('boss.model', id)
    if (providerID) localStorage.setItem('boss.modelProvider', providerID)
    else localStorage.removeItem('boss.modelProvider')
  } catch { /* ignore */ }
}

export function loadVariant(): void {
  try {
    const saved = localStorage.getItem('boss.variant')
    appStore.setState({ variant: saved || null })
  } catch {
    /* ignore */
  }
}

export function setVariant(v: string | null, sessionId: string | null = appStore.getState().activeSessionId): void {
  if (sessionId) {
    appStore.setState((state) => {
      const variantsBySession = { ...state.variantsBySession, [sessionId]: v }
      persistThreadPreference('boss.variantsBySession', variantsBySession)
      return { variantsBySession }
    })
    return
  }
  appStore.setState({ variant: v })
  try {
    if (v) localStorage.setItem('boss.variant', v)
    else localStorage.removeItem('boss.variant')
  } catch {
    /* ignore */
  }
}

function modelKeyWithVariant(model: string | null, sessionId?: string): { providerID: string; modelID: string; variant?: string } | undefined {
  const key = model ? resolveModelKey(model, sessionId) : undefined
  if (!key) return undefined
  const variant = variantForSession(sessionId)
  if (variant) return { ...key, variant }
  return key
}

export function loadMode(): void {
  try {
    const saved = localStorage.getItem('boss.mode')
    if (saved === 'auto' || saved === 'ask' || saved === 'plan' || saved === 'accept-edits') appStore.setState({ mode: saved })
  } catch {
    /* ignore */
  }
}

export async function loadEngine(): Promise<void> {
  try {
    const backends = await OpenCode.listBackends()
    const saved = localStorage.getItem('boss.engine') as BackendId | null
    const engine = backends.some((backend) => backend.id === saved && backend.available)
      ? saved!
      : backends.find((backend) => backend.available)?.id ?? 'opencode'
    appStore.setState({ backends, engine })
    localStorage.setItem('boss.engine', engine)
    return
  } catch {
    /* main unreachable; fall back to saved preference below */
  }
  try {
    const saved = localStorage.getItem('boss.engine') as BackendId | null
    if (saved && ['opencode', 'pi', 'codex', 'claude'].includes(saved)) appStore.setState({ engine: saved })
  } catch {
    /* ignore */
  }
}

export function setMode(id: BackendModeId, sessionId: string | null = appStore.getState().activeSessionId): void {
  if (sessionId) {
    appStore.setState((state) => {
      const modesBySession = { ...state.modesBySession, [sessionId]: id }
      persistThreadPreference('boss.modesBySession', modesBySession)
      return { modesBySession }
    })
    return
  }
  appStore.setState({ mode: id })
  try {
    localStorage.setItem('boss.mode', id)
  } catch {
    /* ignore */
  }
}

export async function setEngine(id: BackendId): Promise<void> {
  try {
    appStore.setState({ engine: id })
    localStorage.setItem('boss.engine', id)
  } catch {
    /* ignore */
  }
}

export async function cloneThreadToBackend(threadId: string, backendId: BackendId): Promise<void> {
  const source = appStore.getState().sessions.find((session) => session.id === threadId)
  if (!source || (source.backendId ?? 'opencode') === backendId) return
  try {
    const preference = appStore.getState().defaultModels?.[backendId]
    const session = await OpenCode.cloneToBackend(threadId, backendId, undefined, preference ? { model: preference } : undefined)
    applyBackendDefaultModel(session.id, backendId)
    upsertSessionMeta(session.id, {
      kind: 'fork',
      projectPath: appStore.getState().projectPath,
      forkedFrom: { sessionId: threadId }
    })
    await refreshSessions()
    if (!openSessionInWorkspace(session.id)) selectSession(session.id)
  } catch (error) {
    setSessionError(threadId, errorSummary(error))
  }
}

export async function delegateThread(
  threadId: string,
  backendId: BackendId,
  instruction: string,
  placement: DelegatePlacement
): Promise<boolean> {
  try {
    const preference = appStore.getState().defaultModels?.[backendId]
    const session = await OpenCode.delegate(
      threadId,
      backendId,
      instruction,
      placement,
      preference ? { model: preference } : undefined
    )
    applyBackendDefaultModel(session.id, backendId)
    upsertSessionMeta(session.id, {
      kind: 'delegate',
      projectPath: session.projectPath ?? appStore.getState().projectPath,
      forkedFrom: { sessionId: threadId }
    })
    await refreshSessions()
    return true
  } catch (error) {
    setSessionError(threadId, errorSummary(error))
    return false
  }
}

export async function setEmptyThreadBackend(threadId: string, backendId: BackendId): Promise<void> {
  const source = appStore.getState().sessions.find((session) => session.id === threadId)
  if (!source || (source.backendId ?? 'opencode') === backendId) return
  try {
    await OpenCode.setThreadBackend(threadId, backendId)
    appStore.setState((state) => {
      const modelsBySession = { ...state.modelsBySession }
      const modelProvidersBySession = { ...(state.modelProvidersBySession ?? {}) }
      const variantsBySession = { ...state.variantsBySession }
      const modesBySession = { ...state.modesBySession }
      const providersBySession = { ...state.providersBySession }
      delete modelsBySession[threadId]
      delete modelProvidersBySession[threadId]
      delete variantsBySession[threadId]
      delete modesBySession[threadId]
      delete providersBySession[threadId]
      persistThreadPreference('boss.modelsBySession', modelsBySession)
      persistThreadPreference('boss.modelProvidersBySession', modelProvidersBySession)
      persistThreadPreference('boss.variantsBySession', variantsBySession)
      persistThreadPreference('boss.modesBySession', modesBySession)
      return { modelsBySession, modelProvidersBySession, variantsBySession, modesBySession, providersBySession }
    })
    applyBackendDefaultModel(threadId, backendId)
    const defaultMode = appStore.getState().backends.find((backend) => backend.id === backendId)?.modes[0]?.id ?? 'ask'
    setMode(defaultMode, threadId)
    await refreshSessions()
    await refreshProviders(threadId)
    await loadMessages(threadId)
  } catch (error) {
    setSessionError(threadId, errorSummary(error))
  }
}

export async function relayThreadToThread(sourceThreadId: string, targetThreadId: string): Promise<void> {
  try {
    await OpenCode.relayToThread(sourceThreadId, targetThreadId)
    await refreshSessions()
    selectSession(targetThreadId)
  } catch (error) {
    setSessionError(sourceThreadId, errorSummary(error))
  }
}

export function loadAgent(): void {
  try {
    const saved = localStorage.getItem('boss.agent')
    if (saved) appStore.setState({ agent: saved })
  } catch {
    /* ignore */
  }
}

export function setAgent(id: string): void {
  appStore.setState({ agent: id })
  try {
    localStorage.setItem('boss.agent', id)
  } catch {
    /* ignore */
  }
}

export async function autoRespond(sessionID: string, permissionID: string, response: 'once' | 'always' | 'reject'): Promise<void> {
  try {
    await OpenCode.respondPermission(sessionID, permissionID, response)
  } catch {
    /* ignore */
  }
}

export async function respondQuestion(requestID: string, answers: string[][]): Promise<void> {
  try {
    await OpenCode.replyQuestion(requestID, answers)
  } finally {
    appStore.setState((s) => {
      const entry = Object.entries(s.questions).find(([, question]) => question.id === requestID)
      if (!entry) return {}
      const questions = { ...s.questions }
      delete questions[entry[0]]
      return { questions }
    })
  }
}

export async function rejectQuestion(requestID: string): Promise<void> {
  try {
    await OpenCode.rejectQuestion(requestID)
  } finally {
    appStore.setState((s) => {
      const entry = Object.entries(s.questions).find(([, question]) => question.id === requestID)
      if (!entry) return {}
      const questions = { ...s.questions }
      delete questions[entry[0]]
      return { questions }
    })
  }
}

export function pushHistory(sessionId: string, text: string): void {
  if (!sessionId || !text.trim()) return
  appStore.setState((s) => {
    const list = s.history[sessionId] ?? []
    const next = [...list, text].slice(-100)
    return { history: { ...s.history, [sessionId]: next } }
  })
}

export function resolveDefaultModel(sessionId?: string): void {
  const s = appStore.getState()
  const providers = sessionId ? s.providersBySession[sessionId] ?? s.providers : s.providers
  const valid = (id: string, providerID?: string | null): boolean => providers.some((provider) =>
    (!providerID || provider.id === providerID) && providerModels(provider).some((model) => model.id === id)
  )
  const current = sessionId ? s.modelsBySession[sessionId] ?? null : s.model
  const currentProvider = sessionId ? s.modelProvidersBySession?.[sessionId] : s.modelProvider
  if (current && valid(current, currentProvider)) return
  if (sessionId && current) {
    appStore.setState((state) => {
      const modelsBySession = { ...state.modelsBySession }
      const modelProvidersBySession = { ...(state.modelProvidersBySession ?? {}) }
      const variantsBySession = { ...state.variantsBySession }
      delete modelsBySession[sessionId]
      delete modelProvidersBySession[sessionId]
      delete variantsBySession[sessionId]
      persistThreadPreference('boss.modelsBySession', modelsBySession)
      persistThreadPreference('boss.modelProvidersBySession', modelProvidersBySession)
      persistThreadPreference('boss.variantsBySession', variantsBySession)
      return { modelsBySession, modelProvidersBySession, variantsBySession }
    })
  } else if (current) {
    appStore.setState({ model: null, modelProvider: null, variant: null })
  }
  try {
    const saved = localStorage.getItem('boss.model')
    const savedProvider = localStorage.getItem('boss.modelProvider')
    if (saved && valid(saved, savedProvider)) {
      setModel(saved, sessionId ?? null, savedProvider ?? undefined)
      return
    }
  } catch {
    /* ignore */
  }
  const recent = [...s.sessions].sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))[0]
  if (recent?.model?.id && valid(recent.model.id) && !isHighVariant(recent.model.id)) {
    setModel(recent.model.id, sessionId ?? null, recent.model.provider)
    return
  }
  const first = providers[0]
  if (first) {
    const m = providerModels(first).find((mm) => !isHighVariant(mm.id)) ?? providerModels(first)[0]
    if (m) setModel(m.id, sessionId ?? null, first.id)
  }
}

export async function refreshConfig(): Promise<void> {
  try {
    appStore.setState({ config: await OpenCode.config() })
  } catch {
    /* ignore */
  }
}

export async function refreshAgents(): Promise<void> {
  try {
    appStore.setState({ agents: await OpenCode.agents() })
  } catch {
    /* ignore */
  }
}

export async function loadMessages(sessionID: string): Promise<void> {
  try {
    const list = await OpenCode.listMessages(sessionID)
    appStore.setState((s) => ({
      // The main-process transcript is the authoritative projection and already
      // merges richer live parts with native history. Replacing this thread is
      // important: retaining renderer-only message ids can show the same
      // response twice after a backend reconciles its live and history ids.
      messages: { ...s.messages, [sessionID]: list }
    }))
    const state = appStore.getState()
    if (!state.sessionBusy[sessionID] && !recentlySent(sessionID)) finalizeStalledParts(sessionID)
    refreshStreaming()
  } catch {
    /* ignore */
  }
}

/** Wall-clock of the last renderer-initiated send per thread. Bridges the gap
 * between sending and the backend's first busy event; after it expires, only
 * live busy signals keep a thread marked as streaming, so threads whose runs
 * were aborted or crashed (stale running parts, missing completions) settle. */
const lastSendAt: Record<string, number> = {}
const SEND_GRACE_MS = 20_000

export function noteThreadSend(sessionId: string): void {
  lastSendAt[sessionId] = Date.now()
}

function recentlySent(sessionId: string): boolean {
  return Date.now() - (lastSendAt[sessionId] ?? 0) < SEND_GRACE_MS
}

/** An idle thread cannot have running parts; mark leftovers from aborted or
 * failed runs as interrupted so step cards stop spinning. */
export function finalizeStalledParts(sessionId: string): void {
  const state = appStore.getState()
  const msgs = state.messages[sessionId]
  if (!msgs?.some((m) => m.parts.some((p) => p.state?.status === 'running' || p.state?.status === 'pending'))) return
  const next = msgs.map((message) => ({
    ...message,
    parts: message.parts.map((part) =>
      part.state?.status === 'running' || part.state?.status === 'pending'
        ? { ...part, state: { ...part.state, status: 'interrupted' as const } }
        : part
    )
  }))
  appStore.setState((s) => ({ messages: { ...s.messages, [sessionId]: next } }))
}

export function refreshStreaming(sessionId?: string): void {
  const s = appStore.getState()
  const ids = sessionId
    ? [sessionId]
    : [...new Set([s.activeSessionId, ...Object.keys(s.messages), ...Object.keys(s.sessionBusy)].filter(Boolean) as string[])]
  if (ids.length === 0) return
  const streaming = { ...s.streaming }
  let changed = false
  for (const sid of ids) {
    if (s.streamingLocked[sid]) {
      if (streaming[sid]) {
        streaming[sid] = false
        changed = true
      }
      continue
    }
    const msgs = s.messages[sid] ?? []
    const parts = msgs.flatMap((m) => m.parts)
    const runningPart = parts.some((p) => p.state?.status === 'running' || p.state?.status === 'pending')
    const last = msgs[msgs.length - 1]
    const awaiting =
      last !== undefined && (last.info.role === 'user' || (last.info.role === 'assistant' && !last.info.time?.completed))
    const busy = Boolean(s.sessionBusy[sid]) || Boolean(s.compacting[sid])
    // Heuristics (stuck running parts, user-last message) only count near a
    // send; afterwards the backend's busy signal is authoritative. Otherwise
    // aborted runs look alive forever.
    const working = busy || ((runningPart || awaiting) && recentlySent(sid))
    if (working !== Boolean(streaming[sid])) {
      streaming[sid] = working
      changed = true
    }
  }
  if (changed) appStore.setState({ streaming })
}

export async function loadTodos(sessionID: string): Promise<void> {
  try {
    const todos = await OpenCode.todos(sessionID)
    appStore.setState((s) => ({ todos: { ...s.todos, [sessionID]: todos } }))
  } catch {
    /* ignore */
  }
}

export async function refreshDiff(sessionID: string | null): Promise<void> {
  if (!sessionID) {
    appStore.setState({ diffs: null })
    return
  }
  try {
    appStore.setState({ diffs: await OpenCode.diff(sessionID) })
  } catch {
    appStore.setState({ diffs: null })
  }
}

export async function refreshFiles(): Promise<void> {
  try {
    appStore.setState({ files: await OpenCode.fileTree() })
  } catch {
    /* ignore */
  }
}

export function selectSession(id: string, bindWorkspace = true): void {
  const cur = appStore.getState()
  const session = cur.sessions.find((s) => s.id === id)
  // A view holds sessions from wherever they live — every tab carries its own
  // contextPath, so tiling does not care which project a thread belongs to,
  // or whether it belongs to one at all. A chat opening as its own page
  // unmounted the workspace and restarted every terminal in it.
  if (bindWorkspace) {
    openSessionInWorkspace(id)
  }
  if (cur.activeSessionId === id) {
    appStore.setState({ activePage: 'project' })
    void refreshProviders(id)
    void refreshQaPolicy(id)
    void refreshFollowUps(id)
    return
  }
  if (session?.model?.id && !cur.modelsBySession[id]) setModel(session.model.id, id, session.model.provider)
  appStore.setState({
    activeSessionId: id,
    activePage: 'project',
    diffs: null,
    fileContent: null
  })
  void loadMessages(id)
  void loadTodos(id)
  void refreshDiff(id)
  void refreshProviders(id)
  void refreshQaPolicy(id)
  void refreshFollowUps(id)
}

export async function refreshQaPolicy(threadId: string): Promise<void> {
  try {
    const state = await OpenCode.qaPolicy(threadId)
    appStore.setState((current) => ({ qaPolicies: { ...current.qaPolicies, [threadId]: state } }))
  } catch {
    /* QA controls remain in their safe Suggest default if the broker is unavailable. */
  }
}

export async function setQaPolicy(threadId: string, policy: QaPolicy | null): Promise<void> {
  try {
    const state = await OpenCode.setQaPolicy(threadId, policy)
    appStore.setState((current) => ({ qaPolicies: { ...current.qaPolicies, [threadId]: state } }))
  } catch (error) {
    appStore.setState({ lastError: errorSummary(error) })
  }
}

export async function refreshQaDefault(): Promise<void> {
  try {
    appStore.setState({ qaDefault: await OpenCode.qaDefault() })
  } catch {
    /* Keep the safe default. */
  }
}

export async function setQaDefault(policy: QaPolicy): Promise<void> {
  try {
    appStore.setState({ qaDefault: await OpenCode.setQaDefault(policy) })
    if (policy === 'automatic') {
      const computerUse = await window.boss.computerUseStatus().catch(() => appStore.getState().computerUse)
      appStore.setState({ computerUse })
    }
  } catch (error) {
    appStore.setState({ lastError: errorSummary(error) })
  }
}
async function createSession(scope: ThreadCreationScope): Promise<void> {
  try {
    const backendId = appStore.getState().engine
    const session = await OpenCode.createSession(undefined, backendId, scope)
    applyBackendDefaultModel(session.id, backendId)
    upsertSessionMeta(session.id, { kind: 'main', projectPath: session.projectPath ?? '' })
    await refreshSessions()
    const defaultMode = appStore.getState().backends.find((backend) => backend.id === backendId)?.modes[0]?.id ?? 'ask'
    setMode(defaultMode, session.id)
    await refreshProviders(session.id)
    selectSession(session.id)
  } catch {
    /* ignore */
  }
}

export async function newSession(): Promise<void> {
  await createSession('current')
}

export async function newGlobalChat(): Promise<void> {
  await createSession('global')
}

export async function openProject(path: string): Promise<void> {
  let info
  try {
    info = await window.boss.projectSet(path)
  } catch (err) {
    console.error('open project:', err)
    await refreshProject()
    return
  }
  appStore.setState({
    projectPath: info.path,
    selectedCheckoutPath: info.checkoutPath,
    projectCheckouts: info.checkouts,
    activePage: 'project',
    activeSessionId: null,
    // Sessions span every project now, so blanking them here only made the
    // whole sidebar flash empty until refreshSessions repopulated it.
    messages: {},
    diffs: null,
    fileContent: null,
    files: null,
  })
  await refreshSessions()
  await refreshProjects()
  await refreshFiles()
  // Views stay put. They are not owned by a project, so opening one must not
  // replace the layout the user is working in.
}

export async function deleteSession(id: string): Promise<void> {
  try {
    await OpenCode.deleteSession(id)
    const workspace = currentWorkspace()
    if (workspace) {
      updateWorkspace((item) => {
        const views = item.views.map((view) => {
          let root = view.root
          let found = findSessionTab(root, id)
          while (found) {
            root = closeTab(root, found.group.id, found.tab.id)
            found = findSessionTab(root, id)
          }
          const focusedGroupId = findGroup(root, view.focusedGroupId)?.id ?? walkGroups(root)[0].id
          return { ...view, root, focusedGroupId }
        })
        return { ...item, views }
      })
    }
    const cur = appStore.getState()
    if (cur.activeSessionId === id) {
      appStore.setState({ activeSessionId: null, messages: {}, diffs: null, todos: {} })
    }
    appStore.setState((s) => {
      const modelsBySession = { ...s.modelsBySession }
      const modelProvidersBySession = { ...(s.modelProvidersBySession ?? {}) }
      const variantsBySession = { ...s.variantsBySession }
      const modesBySession = { ...s.modesBySession }
      const providersBySession = { ...s.providersBySession }
      delete modelsBySession[id]
      delete modelProvidersBySession[id]
      delete variantsBySession[id]
      delete modesBySession[id]
      delete providersBySession[id]
      persistThreadPreference('boss.modelsBySession', modelsBySession)
      persistThreadPreference('boss.modelProvidersBySession', modelProvidersBySession)
      persistThreadPreference('boss.variantsBySession', variantsBySession)
      persistThreadPreference('boss.modesBySession', modesBySession)
      return {
        archived: s.archived.filter((x) => x !== id),
        modelsBySession,
        modelProvidersBySession,
        variantsBySession,
        modesBySession,
        providersBySession
      }
    })
    await refreshSessions()
  } catch {
    /* ignore */
  }
}

function persistArchived(archived: string[]): void {
  try {
    localStorage.setItem('boss.archived', JSON.stringify(archived))
  } catch {
    /* ignore */
  }
}

export function loadArchived(): void {
  try {
    const parsed = JSON.parse(localStorage.getItem('boss.archived') ?? '[]')
    if (Array.isArray(parsed)) appStore.setState({ archived: parsed.filter((x) => typeof x === 'string') })
  } catch {
    /* ignore */
  }
}

export function toggleArchive(id: string): void {
  appStore.setState((s) => {
    const archived = s.archived.includes(id) ? s.archived.filter((x) => x !== id) : [...s.archived, id]
    persistArchived(archived)
    return { archived }
  })
}

export function archiveAllInPath(path: string): void {
  appStore.setState((s) => {
    const ids = s.sessions.filter((x) => (x.projectPath ?? x.directory ?? x.path) === path).map((x) => x.id)
    const archived = [...new Set([...s.archived, ...ids])]
    persistArchived(archived)
    return { archived }
  })
}

export async function forkSession(id: string): Promise<void> {
  try {
    const session = await OpenCode.fork(id)
    copyThreadModelPreference(id, session.id)
    upsertSessionMeta(session.id, { kind: 'fork', forkedFrom: { sessionId: id } })
    await refreshSessions()
    selectSession(session.id)
  } catch {
    /* ignore */
  }
}

export async function forkSessionIntoWorktree(id: string): Promise<void> {
  try {
    const options = modelKeyWithVariant(modelForSession(id), id)
    const session = await OpenCode.forkIntoWorktree(id, undefined, options ? { model: options } : undefined)
    copyThreadModelPreference(id, session.id)
    upsertSessionMeta(session.id, {
      kind: 'fork',
      projectPath: session.projectPath,
      gitBranch: session.worktree?.branch,
      forkedFrom: { sessionId: id }
    })
    await refreshSessions()
    if (!openSessionInWorkspace(session.id)) selectSession(session.id)
  } catch (error) {
    setSessionError(id, errorSummary(error))
  }
}

export async function removeSessionWorktree(id: string): Promise<void> {
  const session = appStore.getState().sessions.find((item) => item.id === id)
  if (!session?.worktree || session.worktree.status !== 'active') return
  try {
    await OpenCode.removeWorktree(session.worktree.id)
    await refreshSessions()
  } catch (error) {
    setSessionError(id, errorSummary(error))
  }
}

export async function revertMessage(sessionID: string, messageID: string): Promise<void> {
  try {
    await OpenCode.revertMessage(sessionID, messageID)
  } catch {
    /* ignore */
  }
  const state = appStore.getState()
  const msgs = state.messages[sessionID] ?? []
  const idx = msgs.findIndex((m) => m.info.id === messageID)
  const revertedIds =
    idx >= 0
      ? msgs.slice(idx).map((m) => m.info.id)
      : [messageID]
  appStore.setState((s) => ({
    reverted: { ...s.reverted, [sessionID]: [...new Set([...(s.reverted[sessionID] ?? []), ...revertedIds])] },
    gitRefresh: s.gitRefresh + 1
  }))
  await loadMessages(sessionID)
  await refreshSessions()
  await refreshFiles()
}

export async function unrevertSession(sessionID: string): Promise<void> {
  try {
    await OpenCode.unrevert(sessionID)
  } catch {
    /* ignore */
  }
  appStore.setState((s) => {
    const reverted = { ...s.reverted }
    delete reverted[sessionID]
    return { reverted, gitRefresh: s.gitRefresh + 1 }
  })
  await loadMessages(sessionID)
  await refreshSessions()
  await refreshFiles()
}

export async function forkFromMessage(sessionID: string, messageID?: string, draft?: string): Promise<void> {
  try {
    const session = await OpenCode.fork(sessionID, messageID)
    copyThreadModelPreference(sessionID, session.id)
    upsertSessionMeta(session.id, { kind: 'fork', forkedFrom: { sessionId: sessionID, messageId: messageID } })
    await refreshSessions()
    selectSession(session.id)
    if (draft?.trim()) {
      appStore.setState((state) => ({
        drafts: { ...state.drafts, [session.id]: draft },
        composerEpoch: state.composerEpoch + 1
      }))
    }
  } catch (error) {
    setSessionError(sessionID, errorSummary(error))
  }
}

export async function editMessage(sessionID: string, messageID: string, text: string): Promise<void> {
  await revertMessage(sessionID, messageID)
  if (text.trim()) {
    appStore.setState((s) => ({
      drafts: { ...s.drafts, [sessionID]: text },
      composerEpoch: s.composerEpoch + 1
    }))
  }
}

export async function runCommand(sessionID: string, command: string, args: string): Promise<void> {
  appStore.setState((st) => ({
    streaming: { ...st.streaming, [sessionID]: true },
    lastError: null,
    lastErrorBySession: { ...st.lastErrorBySession, [sessionID]: '' },
    streamingLocked: { ...st.streamingLocked, [sessionID]: false }
  }))
  const cur = appStore.getState()
  const model = modelForSession(sessionID)
  const mode = modeForSession(sessionID)
  const modelKey = model ? modelKeyWithVariant(model, sessionID) : undefined
  const agent = mode === 'plan' ? 'plan' : cur.agent || 'build'
  try {
    const backendId = cur.sessions.find((session) => session.id === sessionID)?.backendId ?? 'opencode'
    noteThreadSend(sessionID)
    if (backendId === 'opencode') {
      await OpenCode.runCommand(sessionID, command, args, { agent, model: modelKey })
    } else {
      await OpenCode.sendMessageAsync(sessionID, [{ type: 'text', text: `/${command}${args ? ` ${args}` : ''}` }], {
        model: modelKey,
        agent,
        mode
      })
    }
  } catch (err) {
    setSessionError(sessionID, errorSummary(err))
  }
  await loadMessages(sessionID)
}

export async function newChatInProject(path: string): Promise<void> {
  await openProject(path)
  await newSession()
}

export function openCommitDialog(path: string): void {
  appStore.setState({ commitPath: path })
}

export async function renameSessionById(id: string, title: string): Promise<void> {
  try {
    await OpenCode.renameSession(id, title)
    await refreshSessions()
  } catch {
    /* ignore */
  }
}

export function resolveModelKey(id: string, sessionId?: string): { providerID: string; modelID: string } | undefined {
  const s = appStore.getState()
  const providers = sessionId ? s.providersBySession[sessionId] ?? s.providers : s.providers
  const preferredProvider = sessionId ? s.modelProvidersBySession?.[sessionId] : s.modelProvider
  if (preferredProvider) {
    const provider = providers.find((item) => item.id === preferredProvider)
    if (provider && providerModels(provider).some((model) => model.id === id)) {
      return { providerID: provider.id, modelID: id }
    }
  }
  for (const p of providers) {
    if (providerModels(p).some((m) => m.id === id)) {
      return { providerID: p.id, modelID: id }
    }
  }
  return undefined
}

export async function sendPrompt(text: string, sessionId?: string, attachments?: Attachment[]): Promise<void> {
  const cur = appStore.getState()
  const sessionID = sessionId ?? cur.activeSessionId
  if (!sessionID) return
  if (!text.trim() && (!attachments || attachments.length === 0)) return
  const parts: unknown[] = []
  for (const a of attachments ?? []) {
    parts.push({ type: 'file', mime: a.mime, filename: a.name, url: a.dataUrl })
  }
  if (text.trim()) parts.push({ type: 'text', text })
  const model = modelForSession(sessionID)
  const mode = modeForSession(sessionID)
  const modelKey = model ? modelKeyWithVariant(model, sessionID) : undefined
  const agent = mode === 'plan' ? 'plan' : cur.agent || 'build'
  const options = { model: modelKey, agent, mode }
  if (cur.streaming[sessionID] || cur.sessionBusy[sessionID]) {
    try {
      const followUps = await OpenCode.addFollowUp(sessionID, text, attachments, options)
      appStore.setState((state) => ({
        followUps: { ...state.followUps, [sessionID]: followUps },
        lastError: null,
        lastErrorBySession: { ...state.lastErrorBySession, [sessionID]: '' }
      }))
    } catch (error) {
      setSessionError(sessionID, errorSummary(error))
    }
    return
  }
  appStore.setState((st) => ({
    streaming: { ...st.streaming, [sessionID]: true },
    lastError: null,
    lastErrorBySession: { ...st.lastErrorBySession, [sessionID]: '' },
    streamingLocked: { ...st.streamingLocked, [sessionID]: false }
  }))
  noteThreadSend(sessionID)
  try {
    await OpenCode.sendMessageAsync(sessionID, parts, options)
  } catch (err) {
    const raw = String((err as Error).message ?? err)
    const isNetwork = /-> 0:|fetch failed|ECONNREFUSED/i.test(raw)
    const msg = isNetwork
      ? 'Couldn’t reach the selected backend. Your message was not sent; please try again.'
      : errorSummary(err)
    const providerID = modelKey?.providerID
    const noAccess = /no access|subscription|upgrade|credits|401|403/i.test(msg)
    if (noAccess && providerID) {
      const provider = appStore.getState().providers.find((p) => p.id === providerID)
      const base = provider ? providerModels(provider).find((m) => !isHighVariant(m.id)) : undefined
      if (base && base.id !== model) {
        setModel(base.id, sessionID, providerID)
        setSessionError(sessionID, `No access to “${model}” — switched to ${base.name ?? base.id}.`)
      } else {
        setSessionError(sessionID, msg)
      }
    } else {
      setSessionError(sessionID, msg)
    }
  }
  await loadMessages(sessionID)
  setTimeout(() => {
    void loadMessages(sessionID)
  }, 1200)
}

export async function updateFollowUp(threadId: string, followUpId: string, text: string): Promise<void> {
  try {
    const followUps = await OpenCode.updateFollowUp(threadId, followUpId, text)
    appStore.setState((state) => ({ followUps: { ...state.followUps, [threadId]: followUps } }))
  } catch (error) {
    setSessionError(threadId, errorSummary(error))
  }
}

export async function removeFollowUp(threadId: string, followUpId: string): Promise<void> {
  try {
    const followUps = await OpenCode.removeFollowUp(threadId, followUpId)
    appStore.setState((state) => ({ followUps: { ...state.followUps, [threadId]: followUps } }))
  } catch (error) {
    setSessionError(threadId, errorSummary(error))
  }
}

export async function moveFollowUp(threadId: string, followUpId: string, toIndex: number): Promise<void> {
  try {
    const followUps = await OpenCode.moveFollowUp(threadId, followUpId, toIndex)
    appStore.setState((state) => ({ followUps: { ...state.followUps, [threadId]: followUps } }))
  } catch (error) {
    setSessionError(threadId, errorSummary(error))
  }
}

export async function steerFollowUp(threadId: string, followUpId: string): Promise<void> {
  try {
    const followUps = await OpenCode.steerFollowUp(threadId, followUpId)
    appStore.setState((state) => ({ followUps: { ...state.followUps, [threadId]: followUps } }))
  } catch (error) {
    setSessionError(threadId, errorSummary(error))
  }
}

export function setSessionError(sessionID: string, msg: string): void {
  appStore.setState((st) => ({ lastErrorBySession: { ...st.lastErrorBySession, [sessionID]: msg } }))
}

export async function compactSession(sessionID: string): Promise<void> {
  const cur = appStore.getState()
  const model = modelForSession(sessionID)
  const modelKey = model ? resolveModelKey(model, sessionID) : undefined
  const backendId = cur.sessions.find((session) => session.id === sessionID)?.backendId ?? 'opencode'
  if (!modelKey && backendId === 'opencode') {
    setSessionError(sessionID, 'Select a model first to compact the session.')
    return
  }
  appStore.setState((s) => ({ compacting: { ...s.compacting, [sessionID]: true } }))
  try {
    await OpenCode.summarize(sessionID, modelKey)
  } catch (err) {
    setSessionError(sessionID, errorSummary(err))
  }
  appStore.setState((s) => ({ compacting: { ...s.compacting, [sessionID]: false } }))
  await loadMessages(sessionID)
  await refreshSessions()
}

export async function abortRun(sessionID?: string): Promise<void> {
  const cur = appStore.getState()
  const target = sessionID ?? cur.activeSessionId
  if (target) {
    appStore.setState((st) => ({
      streaming: { ...st.streaming, [target]: false },
      streamingLocked: { ...st.streamingLocked, [target]: true }
    }))
  }
  if (!target) return
  try {
    await OpenCode.abort(target)
  } catch {
    /* ignore */
  }
  if (target) void loadMessages(target)
}
export async function refreshOptional(): Promise<void> {
  try {
    appStore.setState({ optional: await window.boss.optionalList() })
  } catch {
    /* ignore */
  }
}

export async function toggleComputerUse(on: boolean): Promise<void> {
  try {
    const status = await window.boss.setComputerUse(on)
    appStore.setState({ computerUse: status })
    if (on) {
      await refreshComputerUsePermissions(true)
    }
  } catch {
    /* ignore */
  }
}

export async function refreshComputerUsePermissions(promptIfMissing = false): Promise<void> {
  try {
    const perms = await window.boss.computerUsePermissions()
    appStore.setState({ computerUsePerms: perms })
    if (promptIfMissing && perms.available) {
      if (!perms.accessibility) await window.boss.requestComputerUsePermission('accessibility').catch(() => {})
      if (!perms.screenRecording) await window.boss.requestComputerUsePermission('screenRecording').catch(() => {})
      const next = await window.boss.computerUsePermissions().catch(() => perms)
      appStore.setState({ computerUsePerms: next })
    }
  } catch {
    /* ignore */
  }
}

export async function openReviewFile(path: string): Promise<void> {
  appStore.setState({ reviewFile: path })
  const workspace = currentWorkspace()
  if (!workspace) return
  addWorkspaceTab(activeWorkspaceView(workspace).focusedGroupId, 'review')
}

export async function refreshProject(): Promise<void> {
  try {
    const info = await window.boss.projectCurrent()
    appStore.setState({
      projectPath: info.path,
      selectedCheckoutPath: info.checkoutPath,
      projectCheckouts: info.checkouts
    })
  } catch {
    /* ignore */
  }
}

export async function openProjectFolder(): Promise<void> {
  try {
    const path = await window.boss.projectChoose()
    if (!path) return
    const info = await window.boss.projectSet(path)
    appStore.setState({
      projectPath: info.path,
      selectedCheckoutPath: info.checkoutPath,
      projectCheckouts: info.checkouts,
      activePage: 'project',
      activeSessionId: null,
      sessions: [],
      messages: {},
      diffs: null
    })
    await refreshSessions()
    await refreshProjects()
    // A linked worktree opens its repository, not a second project. Without
    // saying so, picking a worktree looks like BOSS ignored the folder chosen.
    if (info.checkoutPath && info.checkoutPath !== info.path) {
      const branch = info.checkouts.find((checkout) => checkout.path === info.checkoutPath)?.branch
      appStore.setState({
        confirm: {
          title: 'Opened as a checkout',
          message: `${folderName(info.checkoutPath)} is a git worktree of ${folderName(info.path)}, so BOSS opened that project with ${branch ? `the ${branch} branch` : 'this worktree'} as the active checkout. Switch checkouts from the project header.`,
          confirmLabel: 'Got it',
          notice: true,
          action: () => {}
        }
      })
    }
  } catch (err) {
    console.error('open project folder:', err)
  }
}

function folderName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

export function loadSpeechPrefs(): void {
  try {
    const voice = localStorage.getItem('boss.ttsVoice')
    if (voice) appStore.setState({ ttsVoice: voice })
    const speakAloud = localStorage.getItem('boss.speakAloud')
    if (speakAloud !== null) appStore.setState({ speakAloud: speakAloud === '1' })
  } catch {
    /* ignore */
  }
}

export function setTtsVoice(voice: string): void {
  appStore.setState({ ttsVoice: voice })
  try {
    localStorage.setItem('boss.ttsVoice', voice)
  } catch {
    /* ignore */
  }
}

export function setSpeakAloud(on: boolean): void {
  appStore.setState({ speakAloud: on })
  try {
    localStorage.setItem('boss.speakAloud', on ? '1' : '0')
  } catch {
    /* ignore */
  }
}

let ttsAudio: HTMLAudioElement | null = null

export async function speakText(text: string): Promise<void> {
  const cur = appStore.getState()
  const trimmed = text.trim()
  if (!trimmed) return
  try {
    const result = await window.boss.ttsSpeak({ text: trimmed, voice: cur.ttsVoice })
    if (!result.ok) {
      if (result.error) appStore.setState({ lastError: `TTS: ${result.error}` })
      return
    }
    if (!result.dataUrl) return
    ttsAudio?.pause()
    ttsAudio = new Audio(result.dataUrl)
    void ttsAudio.play()
  } catch (err) {
    appStore.setState({ lastError: errorSummary(err) })
  }
}

export function stopSpeaking(): void {
  ttsAudio?.pause()
  ttsAudio = null
}

let micSession: ReturnType<typeof startMicCapture> extends Promise<infer T> ? T | null : null = null
let micDrainTimer: number | null = null
let micTranscribing = false
let micTargetId: string | null = null

export interface AsrTextEvent {
  targetId: string
  text: string
}

const asrTextListeners = new Set<(evt: AsrTextEvent) => void>()

export function onAsrText(cb: (evt: AsrTextEvent) => void): () => void {
  asrTextListeners.add(cb)
  return () => {
    asrTextListeners.delete(cb)
  }
}

function emitAsrText(targetId: string, text: string): void {
  const trimmed = text.trim()
  if (!trimmed) return
  for (const cb of asrTextListeners) cb({ targetId, text: trimmed })
}

export async function toggleAsr(targetId: string): Promise<void> {
  const cur = appStore.getState()
  if (cur.asr.listening || micSession) {
    await stopAsrRecording()
    return
  }
  micTargetId = targetId
  try {
    micSession = await startMicCapture()
    appStore.setState((s) => ({ asr: { ...s.asr, listening: true }, asrTargetId: targetId }))
    // While recording, transcribe a rolling segment every ~2.2s so text
    // appears live instead of only when the button is released.
    micDrainTimer = window.setInterval(() => {
      void transcribeMicSegment()
    }, 2200)
  } catch (err) {
    micSession = null
    micTargetId = null
    appStore.setState({ asrTargetId: null, lastError: `Mic: ${errorSummary(err)}` })
  }
}

async function transcribeMicSegment(): Promise<void> {
  if (!micSession || micTranscribing) return
  micTranscribing = true
  try {
    const pcm = micSession.drain()
    if (pcm.length < 8000) return // less than ~0.5s — wait for more
    const { text, error } = await window.boss.asrTranscribe({ pcm })
    if (error) {
      appStore.setState({ lastError: `Speech input: ${error}` })
      return
    }
    if (micTargetId) emitAsrText(micTargetId, text)
  } catch (err) {
    appStore.setState({ lastError: `Speech input: ${errorSummary(err)}` })
  } finally {
    micTranscribing = false
  }
}

async function stopAsrRecording(): Promise<void> {
  const session = micSession
  const targetId = micTargetId
  micSession = null
  micTargetId = null
  if (micDrainTimer !== null) {
    window.clearInterval(micDrainTimer)
    micDrainTimer = null
  }
  appStore.setState((s) => ({ asr: { ...s.asr, listening: false }, asrTargetId: null }))
  if (!session) return
  let pcm: Float32Array
  try {
    pcm = await session.stop()
  } catch (err) {
    appStore.setState({ lastError: `Mic: ${errorSummary(err)}` })
    return
  }
  if (pcm.length < 8000) {
    // Too little to bother transcribing.
    return
  }
  try {
    const { text, error } = await window.boss.asrTranscribe({ pcm })
    if (error) {
      appStore.setState({ lastError: `Speech input: ${error}` })
      return
    }
    if (targetId) emitAsrText(targetId, text)
  } catch (err) {
    appStore.setState({ lastError: `Speech input: ${errorSummary(err)}` })
  }
}

export function applySpeechStatus(status: { tts: TtsStatus; asr: AsrStatus }): void {
  appStore.setState({ tts: status.tts, asr: status.asr })
}

export async function refreshSites(): Promise<void> {
  try {
    appStore.setState({ sites: await window.boss.sitesList() })
  } catch {
    /* ignore */
  }
}

export async function refreshCloudflare(): Promise<void> {
  try {
    appStore.setState({ cloudflare: await window.boss.sitesCfGet() })
  } catch {
    /* ignore */
  }
}

export async function publishSiteFromPicker(): Promise<void> {
  try {
    const folder = await window.boss.sitesChooseFolder()
    if (!folder) return
    const site = await window.boss.sitesPublish(folder)
    appStore.setState((s) => ({ sites: [site, ...s.sites.filter((item) => item.id !== site.id)] }))
  } catch (err) {
    appStore.setState({ lastError: errorSummary(err) })
  }
}

export async function removeSite(id: string): Promise<void> {
  try {
    await window.boss.sitesRemove(id)
    appStore.setState((s) => ({ sites: s.sites.filter((site) => site.id !== id) }))
  } catch (err) {
    appStore.setState({ lastError: errorSummary(err) })
  }
}

export async function deploySite(id: string): Promise<void> {
  appStore.setState((s) => ({ siteDeploying: { ...s.siteDeploying, [id]: true } }))
  try {
    const site = await window.boss.sitesDeploy(id)
    appStore.setState((s) => ({
      sites: s.sites.map((item) => (item.id === id ? site : item)),
      siteDeploying: { ...s.siteDeploying, [id]: false }
    }))
  } catch (err) {
    appStore.setState((s) => ({
      siteDeploying: { ...s.siteDeploying, [id]: false },
      lastError: errorSummary(err)
    }))
    await refreshSites()
  }
}

export async function unpublishSite(id: string): Promise<void> {
  appStore.setState((s) => ({ siteUnpublishing: { ...s.siteUnpublishing, [id]: true } }))
  try {
    const site = await window.boss.sitesUnpublish(id)
    appStore.setState((s) => ({
      sites: s.sites.map((item) => (item.id === id ? site : item)),
      siteUnpublishing: { ...s.siteUnpublishing, [id]: false }
    }))
  } catch (err) {
    appStore.setState((s) => ({
      siteUnpublishing: { ...s.siteUnpublishing, [id]: false },
      lastError: errorSummary(err)
    }))
    await refreshSites()
  }
}

export async function setCloudflareConfig(token: string, accountId: string): Promise<boolean> {
  try {
    appStore.setState({ cloudflare: await window.boss.sitesCfSet(token, accountId) })
    return true
  } catch (err) {
    appStore.setState({ lastError: errorSummary(err) })
    return false
  }
}

export async function clearCloudflareConfig(): Promise<void> {
  try {
    appStore.setState({ cloudflare: await window.boss.sitesCfClear() })
  } catch (err) {
    appStore.setState({ lastError: errorSummary(err) })
  }
}

export async function openSiteInBrowser(url: string): Promise<void> {
  showPage('project')
  const state = appStore.getState()
  let workspace = state.projectWorkspace
  if (!workspace) {
    loadProjectWorkspace()
    workspace = appStore.getState().projectWorkspace
  }
  if (!workspace) {
    void window.boss.openExternal(url)
    return
  }
  const view = activeWorkspaceView(workspace)
  const groupId = findGroup(view.root, view.focusedGroupId)?.id ?? walkGroups(view.root)[0]?.id
  if (!groupId) {
    void window.boss.openExternal(url)
    return
  }
  const created = tab('browser')
  updateWorkspaceView((item) => ({
    ...item,
    root: addTab(item.root, groupId, created),
    focusedGroupId: groupId
  }))
  const browseId = `workspace-${created.id}`
  setTimeout(() => {
    void window.boss.browseNavigate(browseId, url)
  }, 120)
}
