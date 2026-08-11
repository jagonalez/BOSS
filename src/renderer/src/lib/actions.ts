import { appStore, upsertMessagesFromList, type Attachment, type PanelKind, type PanelTab } from '../state/AppState'
import { OpenCode, isHighVariant, providerModels } from './opencode'
import { errorSummary } from './errors'
import { startMicCapture } from './mic'
import type { ReviewRun, SessionMeta } from '@shared/opencode'
import type { AsrStatus, TtsStatus } from '@shared/speech'
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
  await newSession()
  const id = appStore.getState().activeSessionId
  if (id) await sendPrompt(prompt, id, attachments)
}

export function sessionMetaFor(sessionId: string): SessionMeta | undefined {
  return appStore.getState().sessionMeta[sessionId]
}

export function syncPanelToMeta(): void {
  const s = appStore.getState()
  if (!s.activeSessionId) return
  upsertSessionMeta(s.activeSessionId, { panelGroups: s.panelGroups })
}

export function loadPanelForSession(sessionId: string): void {
  const meta = appStore.getState().sessionMeta[sessionId]
  appStore.setState({ panelGroups: meta?.panelGroups ? JSON.parse(JSON.stringify(meta.panelGroups)) : [] })
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
  const modelKey = cur.model ? resolveModelKey(cur.model) : undefined
  const agent = cur.mode === 'plan' ? 'plan' : cur.agent || 'build'
  const parts = [
    {
      type: 'text',
      text: `Review the current ${target} changes. Report findings as a concise, prioritized list of issues (bugs, security, performance, style) with file references where possible.`
    }
  ]
  try {
    await OpenCode.sendMessageAsync(sessionID, parts, { model: modelKey, agent })
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

export async function refreshProjects(): Promise<void> {
  try {
    appStore.setState({ projects: await OpenCode.projectList() })
  } catch {
    /* ignore */
  }
}

export async function refreshProviders(): Promise<void> {
  try {
    const { all, connected } = await OpenCode.providers()
    const connectedSet = new Set(connected ?? [])
    const filtered = (all ?? []).filter((p) => connectedSet.has(p.id))
    appStore.setState({ providers: filtered.length > 0 ? filtered : all ?? [] })
    resolveDefaultModel()
  } catch {
    /* ignore */
  }
}

export function setModel(id: string): void {
  appStore.setState({ model: id, variant: null })
  try {
    localStorage.setItem('ralf.model', id)
  } catch {
    /* ignore */
  }
}

export function loadVariant(): void {
  try {
    const saved = localStorage.getItem('ralf.variant')
    appStore.setState({ variant: saved || null })
  } catch {
    /* ignore */
  }
}

export function setVariant(v: string | null): void {
  appStore.setState({ variant: v })
  try {
    if (v) localStorage.setItem('ralf.variant', v)
    else localStorage.removeItem('ralf.variant')
  } catch {
    /* ignore */
  }
}

function modelKeyWithVariant(model: string | null): { providerID: string; modelID: string; variant?: string } | undefined {
  const key = model ? resolveModelKey(model) : undefined
  if (!key) return undefined
  const variant = appStore.getState().variant
  if (variant) return { ...key, variant }
  return key
}

export function loadMode(): void {
  try {
    const saved = localStorage.getItem('ralf.mode')
    if (saved === 'auto' || saved === 'ask' || saved === 'plan') appStore.setState({ mode: saved })
  } catch {
    /* ignore */
  }
}

export async function loadEngine(): Promise<void> {
  // Main is the source of truth for the running engine (RALF_ENGINE / engine switch).
  try {
    const engine = await window.ralf.getBackendEngine()
    if (engine === 'opencode' || engine === 'pi') {
      appStore.setState({ engine })
      try {
        localStorage.setItem('ralf.engine', engine)
      } catch {
        /* ignore */
      }
      return
    }
  } catch {
    /* main unreachable; fall back to saved preference below */
  }
  try {
    const saved = localStorage.getItem('ralf.engine')
    if (saved === 'opencode' || saved === 'pi') appStore.setState({ engine: saved })
  } catch {
    /* ignore */
  }
}

export function setMode(id: 'auto' | 'ask' | 'plan'): void {
  appStore.setState({ mode: id })
  try {
    localStorage.setItem('ralf.mode', id)
  } catch {
    /* ignore */
  }
}

export async function setEngine(id: 'opencode' | 'pi'): Promise<void> {
  try {
    await window.ralf.setBackendEngine(id)
    appStore.setState({ engine: id })
    localStorage.setItem('ralf.engine', id)
  } catch {
    /* ignore */
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

export function pushHistory(sessionId: string, text: string): void {
  if (!sessionId || !text.trim()) return
  appStore.setState((s) => {
    const list = s.history[sessionId] ?? []
    const next = [...list, text].slice(-100)
    return { history: { ...s.history, [sessionId]: next } }
  })
}

export function resolveDefaultModel(): void {
  const s = appStore.getState()
  if (s.model) return
  const valid = (id: string): boolean => s.providers.some((p) => providerModels(p).some((m) => m.id === id))
  try {
    const saved = localStorage.getItem('ralf.model')
    if (saved && valid(saved)) {
      appStore.setState({ model: saved })
      return
    }
  } catch {
    /* ignore */
  }
  const recent = [...s.sessions].sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))[0]
  if (recent?.model?.id && valid(recent.model.id) && !isHighVariant(recent.model.id)) {
    setModel(recent.model.id)
    return
  }
  const first = s.providers[0]
  if (first) {
    const m = providerModels(first).find((mm) => !isHighVariant(mm.id)) ?? providerModels(first)[0]
    if (m) setModel(m.id)
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

export function refreshStreaming(): void {
  const s = appStore.getState()
  const sid = s.activeSessionId
  if (!sid) return
  if (s.streamingLocked[sid]) {
    if (s.streaming[sid]) appStore.setState((st) => ({ streaming: { ...st.streaming, [sid]: false } }))
    return
  }
  const msgs = s.messages[sid] ?? []
  const parts = msgs.flatMap((m) => m.parts)
  const runningPart = parts.some((p) => p.state?.status === 'running' || p.state?.status === 'pending')
  const last = msgs[msgs.length - 1]
  const awaiting =
    last !== undefined && (last.info.role === 'user' || (last.info.role === 'assistant' && !last.info.time?.completed))
  const busy = Boolean(s.sessionBusy[sid]) || Boolean(s.compacting[sid])
  const working = runningPart || awaiting || busy
  if (working !== s.streaming[sid]) {
    appStore.setState((st) => ({ streaming: { ...st.streaming, [sid]: working } }))
  }
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

export function selectSession(id: string): void {
  const cur = appStore.getState()
  if (cur.activeSessionId === id) return
  const session = cur.sessions.find((s) => s.id === id)
  if (session?.model?.id) setModel(session.model.id)
  appStore.setState({
    activeSessionId: id,
    diffs: null,
    fileContent: null
  })
  void loadMessages(id)
  void loadTodos(id)
  void refreshDiff(id)
}
export async function newSession(): Promise<void> {
  try {
    const session = await OpenCode.createSession()
    upsertSessionMeta(session.id, { kind: 'main', projectPath: appStore.getState().projectPath })
    await refreshSessions()
    selectSession(session.id)
  } catch {
    /* ignore */
  }
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
    activeSessionId: null,
    sessions: [],
    messages: {},
    diffs: null,
    fileContent: null,
    files: null,
    panelOpen: true
  })
  await refreshSessions()
  await refreshProjects()
  await refreshFiles()
}

export async function deleteSession(id: string): Promise<void> {
  try {
    await OpenCode.deleteSession(id)
    const cur = appStore.getState()
    if (cur.activeSessionId === id) {
      appStore.setState({ activeSessionId: null, messages: {}, diffs: null, todos: {} })
    }
    appStore.setState((s) => ({ archived: s.archived.filter((x) => x !== id) }))
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
    const ids = s.sessions.filter((x) => (x.directory || x.path) === path).map((x) => x.id)
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
  const modelKey = cur.model ? modelKeyWithVariant(cur.model) : undefined
  const agent = cur.mode === 'plan' ? 'plan' : cur.agent || 'build'
  try {
    await OpenCode.runCommand(sessionID, command, args, { agent, model: modelKey })
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

export function resolveModelKey(id: string): { providerID: string; modelID: string } | undefined {
  const s = appStore.getState()
  for (const p of s.providers) {
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
  const modelKey = cur.model ? modelKeyWithVariant(cur.model) : undefined
  const agent = cur.mode === 'plan' ? 'plan' : cur.agent || 'build'
  try {
    await OpenCode.sendMessageAsync(sessionID, parts, {
      model: modelKey,
      agent
    })
  } catch (err) {
    const raw = String((err as Error).message ?? err)
    const isNetwork = /-> 0:|fetch failed|ECONNREFUSED/i.test(raw)
    const msg = isNetwork
      ? 'Couldn’t reach the opencode server — it may be restarting. Your message was not sent; please try again.'
      : errorSummary(err)
    const providerID = modelKey?.providerID
    const noAccess = /no access|subscription|upgrade|credits|401|403/i.test(msg)
    if (noAccess && providerID) {
      const provider = appStore.getState().providers.find((p) => p.id === providerID)
      const base = provider ? providerModels(provider).find((m) => !isHighVariant(m.id)) : undefined
      if (base && base.id !== cur.model) {
        setModel(base.id)
        setSessionError(sessionID, `No access to “${cur.model}” — switched to ${base.name ?? base.id}.`)
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
  const modelKey = cur.model ? resolveModelKey(cur.model) : undefined
  if (!modelKey) {
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

let panelCounter = 0

function defaultPanelWidth(): number {
  try {
    const saved = Number(localStorage.getItem('ralf.panelWidth'))
    if (Number.isFinite(saved) && saved >= 300) return Math.min(saved, 900)
  } catch {
    /* ignore */
  }
  return 460
}

export function addPanelGroup(): void {
  appStore.setState((s) => ({
    panelOpen: true,
    panelGroups: [...s.panelGroups, { id: `grp-${Date.now()}-${panelCounter++}`, tabs: [], activeTabId: null, width: defaultPanelWidth() }]
  }))
}

export async function openPanelTab(kind: PanelKind, groupId?: string): Promise<void> {
  const s = appStore.getState()
  const single = kind === 'review' || kind === 'browse'
  if (single) {
    for (const g of s.panelGroups) {
      const existing = g.tabs.find((t) => t.kind === kind)
      if (existing) {
        appStore.setState({
          panelOpen: true,
          panelGroups: s.panelGroups.map((gg) => (gg.id === g.id ? { ...gg, activeTabId: existing.id } : gg))
        })
        return
      }
    }
  }
  let target = groupId ? s.panelGroups.find((g) => g.id === groupId) : s.panelGroups[s.panelGroups.length - 1]
  if (!target) {
    addPanelGroup()
    target = appStore.getState().panelGroups[appStore.getState().panelGroups.length - 1]
  }
  const tab: PanelTab = { id: `tab-${Date.now()}-${panelCounter++}`, kind }
  if (kind === 'chat') {
    try {
      const session = await OpenCode.createSession()
      tab.sessionId = session.id
      upsertSessionMeta(session.id, { kind: 'side', projectPath: appStore.getState().projectPath })
    } catch (err) {
      const sid = appStore.getState().activeSessionId
      if (sid) setSessionError(sid, 'Couldn’t create side chat: ' + errorSummary(err))
      return
    }
  }
  appStore.setState((prev) => ({
    panelOpen: true,
    panelGroups: prev.panelGroups.map((g) =>
      g.id === target!.id ? { ...g, tabs: [...g.tabs, tab], activeTabId: tab.id } : g
    )
  }))
}

export function closePanelTab(groupId: string, tabId: string): void {
  appStore.setState((prev) => ({
    panelGroups: prev.panelGroups.map((g) => {
      if (g.id !== groupId) return g
      const tabs = g.tabs.filter((t) => t.id !== tabId)
      let activeTabId = g.activeTabId
      if (g.activeTabId === tabId) {
        const idx = g.tabs.findIndex((t) => t.id === tabId)
        activeTabId = (tabs[idx] ?? tabs[idx - 1] ?? tabs[0] ?? null)?.id ?? null
      }
      return { ...g, tabs, activeTabId }
    })
  }))
}

export function closePanelGroup(groupId: string): void {
  appStore.setState((prev) => ({ panelGroups: prev.panelGroups.filter((g) => g.id !== groupId) }))
}

export function setPanelWidth(groupId: string, width: number): void {
  appStore.setState((prev) => ({
    panelGroups: prev.panelGroups.map((g) => (g.id === groupId ? { ...g, width } : g))
  }))
  try {
    localStorage.setItem('ralf.panelWidth', String(width))
  } catch {
    /* ignore */
  }
}

export async function openReviewFile(path: string): Promise<void> {
  appStore.setState({ reviewFile: path })
  await openPanelTab('review')
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
    appStore.setState({ projectPath: path, activeSessionId: null, sessions: [], messages: {}, diffs: null })
    await window.ralf.projectSet(path)
    await refreshSessions()
    await refreshProjects()
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
let micSessionId: string | null = null

export interface AsrTextEvent {
  sessionId: string
  text: string
}

const asrTextListeners = new Set<(evt: AsrTextEvent) => void>()

export function onAsrText(cb: (evt: AsrTextEvent) => void): () => void {
  asrTextListeners.add(cb)
  return () => {
    asrTextListeners.delete(cb)
  }
}

function emitAsrText(sessionId: string, text: string): void {
  const trimmed = text.trim()
  if (!trimmed) return
  for (const cb of asrTextListeners) cb({ sessionId, text: trimmed })
}

export async function toggleAsr(): Promise<void> {
  const cur = appStore.getState()
  if (cur.asr.listening || micSession) {
    await stopAsrRecording()
    return
  }
  micSessionId = cur.activeSessionId
  try {
    micSession = await startMicCapture()
    appStore.setState((s) => ({ asr: { ...s.asr, listening: true } }))
    // While recording, transcribe a rolling segment every ~2.2s so text
    // appears live instead of only when the button is released.
    micDrainTimer = window.setInterval(() => {
      void transcribeMicSegment()
    }, 2200)
  } catch (err) {
    micSession = null
    appStore.setState({ lastError: `Mic: ${errorSummary(err)}` })
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
    if (micSessionId) emitAsrText(micSessionId, text)
  } catch (err) {
    appStore.setState({ lastError: `Speech input: ${errorSummary(err)}` })
  } finally {
    micTranscribing = false
  }
}

async function stopAsrRecording(): Promise<void> {
  const session = micSession
  const sessionId = micSessionId
  micSession = null
  micSessionId = null
  if (micDrainTimer !== null) {
    window.clearInterval(micDrainTimer)
    micDrainTimer = null
  }
  appStore.setState((s) => ({ asr: { ...s.asr, listening: false } }))
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
    if (sessionId) emitAsrText(sessionId, text)
  } catch (err) {
    appStore.setState({ lastError: `Speech input: ${errorSummary(err)}` })
  }
}

export function applySpeechStatus(status: { tts: TtsStatus; asr: AsrStatus }): void {
  appStore.setState({ tts: status.tts, asr: status.asr })
}
