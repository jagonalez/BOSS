import { appStore, upsertMessagesFromList, type PanelKind, type PanelTab } from '../state/AppState'
import { OpenCode, providerModels } from './opencode'

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
    const { all, default: defaults } = await OpenCode.providers()
    appStore.setState({ providers: all })
    const cur = appStore.getState()
    if (!cur.model) {
      const first = all.find((p) => defaults[p.id]) ?? all[0]
      appStore.setState({ model: first ? (defaults[first.id] ?? providerModels(first)[0]?.id ?? null) : null })
    }
  } catch {
    /* ignore */
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
  } catch {
    /* ignore */
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
    await refreshSessions()
  } catch {
    /* ignore */
  }
}

export async function sendPrompt(text: string, sessionId?: string): Promise<void> {
  const cur = appStore.getState()
  const sessionID = sessionId ?? cur.activeSessionId
  if (!sessionID || !text.trim()) return
  appStore.setState({ streaming: true })
  const userParts = [{ type: 'text', text }]
  const model = cur.model ?? undefined
  try {
    await OpenCode.sendMessageAsync(sessionID, userParts, model ? { model } : {})
  } catch {
    /* ignore */
  }
  await loadMessages(sessionID)
  setTimeout(() => {
    void loadMessages(sessionID)
    appStore.setState({ streaming: false })
  }, 1200)
}

export async function abortRun(): Promise<void> {
  const cur = appStore.getState()
  if (!cur.activeSessionId) return
  try {
    await OpenCode.abort(cur.activeSessionId)
  } catch {
    /* ignore */
  }
  appStore.setState({ streaming: false })
  if (cur.activeSessionId) void loadMessages(cur.activeSessionId)
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
  } catch {
    /* ignore */
  }
}

let panelCounter = 0

export async function openPanelTab(kind: PanelKind): Promise<void> {
  const state = appStore.getState()
  if (kind === 'review') {
    const existing = state.tabs.find((t) => t.kind === 'review')
    if (existing) {
      appStore.setState({ panelOpen: true, activeTabId: existing.id })
      return
    }
  }
  const tab: PanelTab = { id: `tab-${Date.now()}-${panelCounter++}`, kind }
  if (kind === 'chat') {
    try {
      const session = await OpenCode.createSession()
      tab.sessionId = session.id
    } catch {
      /* ignore */
    }
  }
  appStore.setState((prev) => ({
    panelOpen: true,
    tabs: [...prev.tabs, tab],
    activeTabId: tab.id
  }))
}

export function closePanelTab(id: string): void {
  appStore.setState((prev) => {
    const tabs = prev.tabs.filter((t) => t.id !== id)
    let activeTabId = prev.activeTabId
    if (prev.activeTabId === id) {
      const idx = prev.tabs.findIndex((t) => t.id === id)
      activeTabId = (tabs[idx] ?? tabs[idx - 1] ?? tabs[0] ?? null)?.id ?? null
    }
    return { tabs, activeTabId }
  })
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
