import { appStore, upsertMessagesFromList, type Attachment } from '../state/AppState'
import { OpenCode, isHighVariant, providerModels } from './opencode'
import { errorSummary } from './errors'
import { startMicCapture } from './mic'
import type { ReviewRun, SessionMeta } from '@shared/opencode'
import type { BackendId, BackendModeId, ThreadCreationScope } from '@shared/backend'
import type { CollaborationPolicy } from '@shared/thread-bus'
import type { AsrStatus, TtsStatus } from '@shared/speech'
import type { AppPage, DropPosition, SplitDirection, WorkspaceTabKind } from '@shared/workspace'
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
  moveTab,
  nextWorkspaceViewName,
  reorderTab,
  resizeSplit,
  saveCustomTemplates,
  saveWorkspace,
  splitGroup,
  tab,
  templateFromWorkspace,
  updateActiveWorkspaceView,
  walkGroups,
  walkTabs,
  workspaceView
} from './workspaces'

export function initializeWorkspaceState(): void {
  appStore.setState({ layoutTemplates: loadTemplates() })
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

export function loadProjectWorkspace(projectKey: string, preferredSessionId?: string): void {
  const workspace = loadWorkspace(projectKey, preferredSessionId)
  appStore.setState({ projectWorkspace: workspace })
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
  if (active?.kind === 'review') void refreshDiff(appStore.getState().activeSessionId)
}

export function addWorkspaceTab(groupId: string, kind: WorkspaceTabKind, sessionId?: string): void {
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
    const existing = walkTabs(view.root).find((item) => item.kind === kind)
    if (existing) {
      const location = findTab(view.root, existing.id)
      if (location) activateWorkspaceTab(location.group.id, existing.id)
      return
    }
  }
  const created = tab(kind, sessionId)
  updateWorkspaceView((item) => ({
    ...item,
    root: addTab(item.root, groupId, created),
    focusedGroupId: groupId
  }))
  if (kind === 'thread' && sessionId) selectSession(sessionId, false)
}

export async function createThreadInGroup(groupId: string, backendId: BackendId = appStore.getState().engine): Promise<void> {
  try {
    const session = await OpenCode.createSession(undefined, backendId)
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

export function closeWorkspaceTab(groupId: string, tabId: string): void {
  const next = updateWorkspaceView((item) => {
    const root = closeTab(item.root, groupId, tabId)
    const focusedGroupId = findGroup(root, item.focusedGroupId)?.id ?? walkGroups(root)[0].id
    return { ...item, root, focusedGroupId }
  })
  if (next) syncFocusedThread()
}

export function closeWorkspaceGroup(groupId: string): void {
  const next = updateWorkspaceView((item) => {
    const root = closeGroup(item.root, groupId)
    return { ...item, root, focusedGroupId: walkGroups(root)[0].id }
  })
  if (next) syncFocusedThread()
}

export function setWorkspaceSplitRatio(splitId: string, ratio: number): void {
  updateWorkspaceView((item) => ({ ...item, root: resizeSplit(item.root, splitId, ratio) }))
}

export function moveWorkspaceTab(tabId: string, targetGroupId: string, position: DropPosition): void {
  const next = updateWorkspaceView((item) => {
    const moved = moveTab(item.root, tabId, targetGroupId, position)
    return { ...item, root: moved.root, focusedGroupId: moved.focusedGroupId }
  })
  if (next) syncFocusedThread()
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
  const nextView = bindTemplate(template, view.name, sessions)
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
    localStorage.setItem('ralf.sessionMeta', JSON.stringify(meta))
  } catch {
    /* ignore */
  }
}

export function loadSessionMeta(): void {
  try {
    const parsed = JSON.parse(localStorage.getItem('ralf.sessionMeta') ?? '{}')
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
    const parsed = JSON.parse(localStorage.getItem('ralf.chatOrder') ?? '[]')
    if (Array.isArray(parsed)) appStore.setState({ chatOrder: parsed.filter((x) => typeof x === 'string') })
  } catch {
    /* ignore */
  }
}

export function setChatOrder(ids: string[]): void {
  appStore.setState({ chatOrder: ids })
  try {
    localStorage.setItem('ralf.chatOrder', JSON.stringify(ids))
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
    await window.ralf.projectSet(path)
    appStore.setState({ projectPath: path })
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

export async function runThreadReview(sessionID: string, target: string): Promise<void> {
  const projectPath = appStore.getState().projectPath
  let baseSha = ''
  try {
    const r = await window.ralf.gitRun(projectPath, ['rev-parse', 'HEAD'])
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
    await OpenCode.sendMessageAsync(sessionID, parts, { model: modelKey, agent, mode })
  } catch (err) {
    setSessionError(sessionID, errorSummary(err))
  }
  await loadMessages(sessionID)
}

export function markStaleReviews(sessionID: string): void {
  const projectPath = appStore.getState().projectPath
  void (async () => {
    let head = ''
    try {
      const r = await window.ralf.gitRun(projectPath, ['rev-parse', 'HEAD'])
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

export async function refreshThreadBus(threadId?: string): Promise<void> {
  try {
    appStore.setState({ threadBus: await OpenCode.threadBus(threadId) })
  } catch {
    /* Thread bus may still be starting during the first renderer refresh. */
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
    appStore.setState({ projects: await OpenCode.projectList() })
  } catch {
    /* ignore */
  }
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
    const connectedSet = new Set(connected ?? [])
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
    const modelsBySession = JSON.parse(localStorage.getItem('ralf.modelsBySession') ?? '{}') as Record<string, string>
    const variantsBySession = JSON.parse(localStorage.getItem('ralf.variantsBySession') ?? '{}') as Record<string, string | null>
    const modesBySession = JSON.parse(localStorage.getItem('ralf.modesBySession') ?? '{}') as Record<string, BackendModeId>
    appStore.setState({ modelsBySession, variantsBySession, modesBySession })
  } catch {
    /* Ignore malformed preferences and retain safe defaults. */
  }
}

export function modelForSession(sessionId?: string): string | null {
  const state = appStore.getState()
  return (sessionId && state.modelsBySession[sessionId]) || state.model
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

export function setModel(id: string, sessionId: string | null = appStore.getState().activeSessionId): void {
  if (sessionId) {
    appStore.setState((state) => {
      const modelsBySession = { ...state.modelsBySession, [sessionId]: id }
      const variantsBySession = { ...state.variantsBySession, [sessionId]: null }
      persistThreadPreference('ralf.modelsBySession', modelsBySession)
      persistThreadPreference('ralf.variantsBySession', variantsBySession)
      return { modelsBySession, variantsBySession }
    })
    return
  }
  appStore.setState({ model: id, variant: null })
  try { localStorage.setItem('ralf.model', id) } catch { /* ignore */ }
}

export function loadVariant(): void {
  try {
    const saved = localStorage.getItem('ralf.variant')
    appStore.setState({ variant: saved || null })
  } catch {
    /* ignore */
  }
}

export function setVariant(v: string | null, sessionId: string | null = appStore.getState().activeSessionId): void {
  if (sessionId) {
    appStore.setState((state) => {
      const variantsBySession = { ...state.variantsBySession, [sessionId]: v }
      persistThreadPreference('ralf.variantsBySession', variantsBySession)
      return { variantsBySession }
    })
    return
  }
  appStore.setState({ variant: v })
  try {
    if (v) localStorage.setItem('ralf.variant', v)
    else localStorage.removeItem('ralf.variant')
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
    const saved = localStorage.getItem('ralf.mode')
    if (saved === 'auto' || saved === 'ask' || saved === 'plan' || saved === 'accept-edits') appStore.setState({ mode: saved })
  } catch {
    /* ignore */
  }
}

export async function loadEngine(): Promise<void> {
  try {
    const backends = await OpenCode.listBackends()
    const saved = localStorage.getItem('ralf.engine') as BackendId | null
    const engine = backends.some((backend) => backend.id === saved && backend.available)
      ? saved!
      : backends.find((backend) => backend.available)?.id ?? 'opencode'
    appStore.setState({ backends, engine })
    localStorage.setItem('ralf.engine', engine)
    return
  } catch {
    /* main unreachable; fall back to saved preference below */
  }
  try {
    const saved = localStorage.getItem('ralf.engine') as BackendId | null
    if (saved && ['opencode', 'pi', 'codex', 'claude'].includes(saved)) appStore.setState({ engine: saved })
  } catch {
    /* ignore */
  }
}

export function setMode(id: BackendModeId, sessionId: string | null = appStore.getState().activeSessionId): void {
  if (sessionId) {
    appStore.setState((state) => {
      const modesBySession = { ...state.modesBySession, [sessionId]: id }
      persistThreadPreference('ralf.modesBySession', modesBySession)
      return { modesBySession }
    })
    return
  }
  appStore.setState({ mode: id })
  try {
    localStorage.setItem('ralf.mode', id)
  } catch {
    /* ignore */
  }
}

export async function setEngine(id: BackendId): Promise<void> {
  try {
    appStore.setState({ engine: id })
    localStorage.setItem('ralf.engine', id)
  } catch {
    /* ignore */
  }
}

export async function cloneThreadToBackend(threadId: string, backendId: BackendId): Promise<void> {
  const source = appStore.getState().sessions.find((session) => session.id === threadId)
  if (!source || (source.backendId ?? 'opencode') === backendId) return
  try {
    const session = await OpenCode.cloneToBackend(threadId, backendId)
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
    const saved = localStorage.getItem('ralf.agent')
    if (saved) appStore.setState({ agent: saved })
  } catch {
    /* ignore */
  }
}

export function setAgent(id: string): void {
  appStore.setState({ agent: id })
  try {
    localStorage.setItem('ralf.agent', id)
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
  const valid = (id: string): boolean => providers.some((p) => providerModels(p).some((m) => m.id === id))
  const current = modelForSession(sessionId)
  if (current && valid(current)) return
  if (sessionId && current) {
    appStore.setState((state) => {
      const modelsBySession = { ...state.modelsBySession }
      const variantsBySession = { ...state.variantsBySession }
      delete modelsBySession[sessionId]
      delete variantsBySession[sessionId]
      return { modelsBySession, variantsBySession }
    })
  } else if (current) {
    appStore.setState({ model: null, variant: null })
  }
  try {
    const saved = localStorage.getItem('ralf.model')
    if (saved && valid(saved)) {
      setModel(saved, sessionId ?? null)
      return
    }
  } catch {
    /* ignore */
  }
  const recent = [...s.sessions].sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))[0]
  if (recent?.model?.id && valid(recent.model.id) && !isHighVariant(recent.model.id)) {
    setModel(recent.model.id, sessionId ?? null)
    return
  }
  const first = providers[0]
  if (first) {
    const m = providerModels(first).find((mm) => !isHighVariant(mm.id)) ?? providerModels(first)[0]
    if (m) setModel(m.id, sessionId ?? null)
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
      messages: upsertMessagesFromList(s.messages, list)
    }))
    refreshStreaming()
  } catch {
    /* ignore */
  }
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
    const working = runningPart || awaiting || busy
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
  const sessionPath = session?.projectPath ?? session?.directory ?? session?.path ?? ''
  const inProject = Boolean(sessionPath && sessionPath !== '/')
  if (bindWorkspace && inProject && cur.projectWorkspace?.projectKey === sessionPath) {
    openSessionInWorkspace(id)
  }
  if (cur.activeSessionId === id) {
    appStore.setState({ activePage: inProject ? 'project' : 'chat' })
    void refreshProviders(id)
    return
  }
  if (session?.model?.id && !cur.modelsBySession[id]) setModel(session.model.id, id)
  appStore.setState({
    activeSessionId: id,
    activePage: inProject ? 'project' : 'chat',
    diffs: null,
    fileContent: null
  })
  void loadMessages(id)
  void loadTodos(id)
  void refreshDiff(id)
  void refreshProviders(id)
}
async function createSession(scope: ThreadCreationScope): Promise<void> {
  try {
    const backendId = appStore.getState().engine
    const session = await OpenCode.createSession(undefined, backendId, scope)
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

export async function importNativeThreads(backendId: BackendId): Promise<number> {
  const imported = await OpenCode.importNativeSessions(backendId)
  await refreshSessions()
  return imported.length
}

export async function openProject(path: string): Promise<void> {
  let info
  try {
    info = await window.ralf.projectSet(path)
  } catch (err) {
    console.error('open project:', err)
    await refreshProject()
    return
  }
  appStore.setState({
    projectPath: info.path,
    activePage: 'project',
    activeSessionId: null,
    sessions: [],
    messages: {},
    diffs: null,
    fileContent: null,
    files: null,
  })
  await refreshSessions()
  await refreshProjects()
  await refreshFiles()
  const preferred = appStore.getState().sessions.find((session) => (session.projectPath ?? session.directory ?? session.path) === info.path)?.id
  loadProjectWorkspace(info.path, preferred)
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
      const variantsBySession = { ...s.variantsBySession }
      const modesBySession = { ...s.modesBySession }
      const providersBySession = { ...s.providersBySession }
      delete modelsBySession[id]
      delete variantsBySession[id]
      delete modesBySession[id]
      delete providersBySession[id]
      persistThreadPreference('ralf.modelsBySession', modelsBySession)
      persistThreadPreference('ralf.variantsBySession', variantsBySession)
      persistThreadPreference('ralf.modesBySession', modesBySession)
      return {
        archived: s.archived.filter((x) => x !== id),
        modelsBySession,
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
    localStorage.setItem('ralf.archived', JSON.stringify(archived))
  } catch {
    /* ignore */
  }
}

export function loadArchived(): void {
  try {
    const parsed = JSON.parse(localStorage.getItem('ralf.archived') ?? '[]')
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
    upsertSessionMeta(session.id, { kind: 'fork', forkedFrom: { sessionId: id } })
    await refreshSessions()
    selectSession(session.id)
  } catch {
    /* ignore */
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

export async function forkFromMessage(sessionID: string, messageID: string): Promise<void> {
  try {
    const session = await OpenCode.fork(sessionID, messageID)
    upsertSessionMeta(session.id, { kind: 'fork', forkedFrom: { sessionId: sessionID, messageId: messageID } })
    await refreshSessions()
    selectSession(session.id)
  } catch {
    /* ignore */
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
  appStore.setState((st) => ({
    streaming: { ...st.streaming, [sessionID]: true },
    lastError: null,
    lastErrorBySession: { ...st.lastErrorBySession, [sessionID]: '' },
    streamingLocked: { ...st.streamingLocked, [sessionID]: false }
  }))
  const model = modelForSession(sessionID)
  const mode = modeForSession(sessionID)
  const modelKey = model ? modelKeyWithVariant(model, sessionID) : undefined
  const agent = mode === 'plan' ? 'plan' : cur.agent || 'build'
  try {
    await OpenCode.sendMessageAsync(sessionID, parts, {
      model: modelKey,
      agent,
      mode
    })
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
        setModel(base.id, sessionID)
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
    appStore.setState({ optional: await window.ralf.optionalList() })
  } catch {
    /* ignore */
  }
}

export async function toggleComputerUse(on: boolean): Promise<void> {
  try {
    const status = await window.ralf.setComputerUse(on)
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
    const perms = await window.ralf.computerUsePermissions()
    appStore.setState({ computerUsePerms: perms })
    if (promptIfMissing && perms.available) {
      if (!perms.accessibility) await window.ralf.requestComputerUsePermission('accessibility').catch(() => {})
      if (!perms.screenRecording) await window.ralf.requestComputerUsePermission('screenRecording').catch(() => {})
      const next = await window.ralf.computerUsePermissions().catch(() => perms)
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
    const info = await window.ralf.projectCurrent()
    appStore.setState({ projectPath: info.path })
  } catch {
    /* ignore */
  }
}

export async function openProjectFolder(): Promise<void> {
  try {
    const path = await window.ralf.projectChoose()
    if (!path) return
    appStore.setState({ projectPath: path, activePage: 'project', activeSessionId: null, sessions: [], messages: {}, diffs: null })
    await window.ralf.projectSet(path)
    await refreshSessions()
    await refreshProjects()
    const preferred = appStore.getState().sessions.find((session) => (session.projectPath ?? session.directory ?? session.path) === path)?.id
    loadProjectWorkspace(path, preferred)
  } catch (err) {
    console.error('open project folder:', err)
  }
}

export function loadSpeechPrefs(): void {
  try {
    const voice = localStorage.getItem('ralf.ttsVoice')
    if (voice) appStore.setState({ ttsVoice: voice })
    const speakAloud = localStorage.getItem('ralf.speakAloud')
    if (speakAloud !== null) appStore.setState({ speakAloud: speakAloud === '1' })
  } catch {
    /* ignore */
  }
}

export function setTtsVoice(voice: string): void {
  appStore.setState({ ttsVoice: voice })
  try {
    localStorage.setItem('ralf.ttsVoice', voice)
  } catch {
    /* ignore */
  }
}

export function setSpeakAloud(on: boolean): void {
  appStore.setState({ speakAloud: on })
  try {
    localStorage.setItem('ralf.speakAloud', on ? '1' : '0')
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
    const result = await window.ralf.ttsSpeak({ text: trimmed, voice: cur.ttsVoice })
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
    const { text, error } = await window.ralf.asrTranscribe({ pcm })
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
    const { text, error } = await window.ralf.asrTranscribe({ pcm })
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
    appStore.setState({ sites: await window.ralf.sitesList() })
  } catch {
    /* ignore */
  }
}

export async function refreshCloudflare(): Promise<void> {
  try {
    appStore.setState({ cloudflare: await window.ralf.sitesCfGet() })
  } catch {
    /* ignore */
  }
}

export async function publishSiteFromPicker(): Promise<void> {
  try {
    const folder = await window.ralf.sitesChooseFolder()
    if (!folder) return
    const site = await window.ralf.sitesPublish(folder)
    appStore.setState((s) => ({ sites: [site, ...s.sites.filter((item) => item.id !== site.id)] }))
  } catch (err) {
    appStore.setState({ lastError: errorSummary(err) })
  }
}

export async function removeSite(id: string): Promise<void> {
  try {
    await window.ralf.sitesRemove(id)
    appStore.setState((s) => ({ sites: s.sites.filter((site) => site.id !== id) }))
  } catch (err) {
    appStore.setState({ lastError: errorSummary(err) })
  }
}

export async function deploySite(id: string): Promise<void> {
  appStore.setState((s) => ({ siteDeploying: { ...s.siteDeploying, [id]: true } }))
  try {
    const site = await window.ralf.sitesDeploy(id)
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
    const site = await window.ralf.sitesUnpublish(id)
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
    appStore.setState({ cloudflare: await window.ralf.sitesCfSet(token, accountId) })
    return true
  } catch (err) {
    appStore.setState({ lastError: errorSummary(err) })
    return false
  }
}

export async function clearCloudflareConfig(): Promise<void> {
  try {
    appStore.setState({ cloudflare: await window.ralf.sitesCfClear() })
  } catch (err) {
    appStore.setState({ lastError: errorSummary(err) })
  }
}

export async function openSiteInBrowser(url: string): Promise<void> {
  showPage('project')
  const state = appStore.getState()
  let workspace = state.projectWorkspace
  if (!workspace) {
    if (!state.projectPath) {
      void window.ralf.openExternal(url)
      return
    }
    loadProjectWorkspace(state.projectPath)
    workspace = appStore.getState().projectWorkspace
  }
  if (!workspace) {
    void window.ralf.openExternal(url)
    return
  }
  const view = activeWorkspaceView(workspace)
  const groupId = findGroup(view.root, view.focusedGroupId)?.id ?? walkGroups(view.root)[0]?.id
  if (!groupId) {
    void window.ralf.openExternal(url)
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
    void window.ralf.browseNavigate(browseId, url)
  }, 120)
}
