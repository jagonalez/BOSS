import React, { useEffect } from 'react'
import { useStore, appStore, applyEvent } from './state/AppState'
import { Sidebar } from './components/Sidebar'
import { Toolbar } from './components/Toolbar'
import { Workspace } from './components/Workspace'
import { CommandCenter } from './components/CommandCenter'
import { SitesPage } from './components/SitesPage'
import { AutomationsPage } from './components/AutomationsPage'
import { ModelSwitchModal } from './components/ModelSwitchModal'
import { applyTheme, loadTheme } from './lib/themes'
import { CommitDialog } from './components/CommitDialog'
import { RenameModal } from './components/RenameModal'
import { ConfirmModal } from './components/ConfirmModal'
import { DelegateModal } from './components/DelegateModal'
import { TaskPolicyModal } from './components/TaskPolicyModal'
import { SettingsModal } from './components/SettingsModal'
import { UpdateBanner } from './components/UpdateBanner'
import {
  refreshAgents,
  refreshConfig,
  refreshDiff,
  refreshOptional,
  refreshProject,
  refreshProjects,
  refreshProviders,
  refreshSessions,
  refreshThreadBus,
  refreshAutomations,
  syncAutomationThreadPreferences,
  finalizeStalledParts,
  noteThreadSettled,
  refreshStreaming,
  runMenuCommand,
  handleProjectOpened,
  loadMode,
  loadThreadPreferences,
  loadAgent,
  loadVariant,
  loadArchived,
  loadSessionMeta,
  loadMessages,
  loadTodos,
  abortRun,
  setAttention,
  clearAttention,
  loadSpeechPrefs,
  applySpeechStatus,
  loadEngine,
  initializeWorkspaceState,
  loadProjectWorkspace,
  setNativeViewsSuspended
} from './lib/actions'

async function refreshAll(): Promise<void> {
  void refreshSessions()
  void refreshProjects()
  void refreshProviders()
  void refreshAgents()
  void refreshConfig()
  void refreshThreadBus()
  void refreshAutomations()
  const id = appStore.getState().activeSessionId
  if (id) {
    void loadMessages(id)
    void loadTodos(id)
    void refreshDiff(id)
  }
}

export function App(): React.JSX.Element {
  const activePage = useStore(appStore, (s) => s.activePage)
  const projectPath = useStore(appStore, (s) => s.projectPath)
  const sessions = useStore(appStore, (s) => s.sessions)
  const modalOpen = useStore(appStore, (s) => Boolean(s.settingsOpen || s.confirm || s.modelSwitch || s.commitPath || s.renameTarget || s.delegateTarget || s.policyTarget))

  useEffect(() => {
    loadArchived()
    loadMode()
    loadThreadPreferences()
    loadAgent()
    loadSessionMeta()
    loadVariant()
    loadSpeechPrefs()
    loadEngine()
    initializeWorkspaceState()
    applyTheme(loadTheme())
  }, [])

  // Views load once and stay. They belong to the app, not to a project, so
  // opening a project no longer swaps the layout the user is working in.
  useEffect(() => {
    loadProjectWorkspace(sessions[0]?.id)
  }, [sessions])

  useEffect(() => {
    if (projectPath) void refreshThreadBus()
  }, [projectPath])

  // The menu names an action and this runs it, so a shortcut and the button
  // that already existed reach the same code.
  useEffect(() => window.boss.onMenuCommand(runMenuCommand), [])

  // `boss <folder>` in a terminal. Main has already opened the project; this
  // brings the window to it. The pending collection covers the launch that
  // started the app, which resolves before this component exists.
  useEffect(() => {
    const stop = window.boss.onProjectOpened(handleProjectOpened)
    void window.boss.projectOpenedPending().then((event) => {
      if (event) handleProjectOpened(event)
    }).catch(() => {})
    return stop
  }, [])

  // Native views are composited over the window, not inside it, so a hidden
  // workspace would leave its browsers floating on top of whichever page is
  // showing. Detach them while it is covered.
  useEffect(() => {
    const covered = activePage === 'command-center' || activePage === 'automations' || activePage === 'sites'
    setNativeViewsSuspended('page-overlay', covered)
    return () => setNativeViewsSuspended('page-overlay', false)
  }, [activePage])

  useEffect(() => {
    setNativeViewsSuspended('app-modal', modalOpen)
    return () => setNativeViewsSuspended('app-modal', false)
  }, [modalOpen])

  useEffect(() => {
    let refreshTimer: number | undefined

    document.documentElement.dataset.platform = window.boss.platform()
    void window.boss.subscribeEvents()

    const offEvent = window.boss.onEvent((data) => {
      let ev: Record<string, unknown>
      try {
        ev = JSON.parse(data) as Record<string, unknown>
      } catch {
        return
      }
      if (ev.type === 'server.connected') {
        appStore.setState({ serverHealthy: true })
        void refreshAll()
        return
      }
      if (ev.type === 'server.disconnected') {
        appStore.setState({ serverHealthy: false })
        return
      }
      const patch = applyEvent(appStore.getState(), ev)
      if (Object.keys(patch).length > 0) appStore.setState(patch)
      switch (ev.type) {
        case 'session.updated':
        case 'session.created':
        case 'session.deleted':
          void refreshSessions()
          break
        case 'session.status':
        case 'session.idle': {
          const props = (ev.properties ?? {}) as { sessionID?: string }
          const sid = props.sessionID ?? appStore.getState().activeSessionId ?? ''
          const wasStreaming = Boolean(appStore.getState().streaming[sid])
          if (ev.type === 'session.idle' && sid) {
            // The turn is over, so a mode that was waiting for it now applies.
            if (appStore.getState().modePending[sid]) {
              appStore.setState((state) => {
                const modePending = { ...state.modePending }
                delete modePending[sid]
                return { modePending }
              })
            }
            finalizeStalledParts(sid)
            // Idle is the authoritative completion edge. Refreshing here also
            // recovers the final response when intermediate backend events
            // were missed during a reconnect or directory change.
            void loadMessages(sid)
            void loadTodos(sid)
          }
          // Before refreshing, so the run's own grace window cannot outvote
          // the idle that ended it.
          noteThreadSettled(sid)
          refreshStreaming(sid)
          if (wasStreaming && !appStore.getState().streaming[sid] && !document.hasFocus()) {
            setAttention('done')
          }
          break
        }
        case 'session.compacted': {
          const props = (ev.properties ?? {}) as { sessionID?: string }
          if (props.sessionID) {
            void loadMessages(props.sessionID)
            void loadTodos(props.sessionID)
          }
          void refreshSessions()
          break
        }
        case 'permission.asked':
        case 'permission.updated': {
          // Main answers Auto and Plan requests against the thread's current
          // mode and never forwards them, so anything arriving here is a
          // request the user is meant to see.
          const patch = applyEvent(appStore.getState(), ev)
          if (Object.keys(patch).length > 0) appStore.setState(patch)
          setAttention('permission')
          break
        }
        case 'question.asked': {
          const patch = applyEvent(appStore.getState(), ev)
          if (Object.keys(patch).length > 0) appStore.setState(patch)
          // A question wants an answer, not a yes/no on a tool call. Saying
          // "Permission needed" here sent people looking for an approval
          // prompt that was never coming.
          setAttention('question')
          break
        }
        case 'session.error': {
          const props = (ev.properties ?? {}) as { sessionID?: string }
          if (props.sessionID) {
            finalizeStalledParts(props.sessionID)
            refreshStreaming(props.sessionID)
            void loadMessages(props.sessionID)
          }
          setAttention('error')
          break
        }
        case 'message.updated':
        case 'message.part.updated':
        case 'message.part.created':
          window.clearTimeout(refreshTimer)
          const props = (ev.properties ?? {}) as { sessionID?: string; part?: { sessionID?: string } }
          const eventSessionId = props.sessionID ?? props.part?.sessionID ?? appStore.getState().activeSessionId ?? undefined
          refreshStreaming(eventSessionId)
          refreshTimer = window.setTimeout(() => {
            const id = eventSessionId
            if (id) {
              void loadMessages(id)
              void loadTodos(id)
            }
          }, 300)
          break
        case 'config.updated':
          void refreshConfig()
          break
        case 'automations.updated':
          syncAutomationThreadPreferences(appStore.getState().automations)
          break
        default:
          break
      }
    })

    const offStatus = window.boss.onServerStatusChanged((info) => {
      appStore.setState({
        serverUrl: info.url,
        serverVersion: info.version,
        serverHealthy: info.healthy
      })
    })

    const offProgress = window.boss.onOptionalProgress((evt) => {
      appStore.setState((s) => ({
        optionalProgress: { ...s.optionalProgress, [evt.id]: evt }
      }))
      if (evt.phase === 'done') void refreshOptional()
    })

    const offSpeech = window.boss.onSpeechStatusChanged(applySpeechStatus)

    // An agent can navigate, click and type in a browser tab you are not
    // looking at. Mark the tab so the work is visible; opening it clears the
    // mark.
    const offBrowseAgent = window.boss.onBrowseAgentActivity((id) => {
      appStore.setState((s) => ({ browseAgentActivity: { ...s.browseAgentActivity, [id]: true } }))
    })

    const offSites = window.boss.onSitesChanged((sites) => appStore.setState({ sites }))
    void window.boss
      .sitesCfGet()
      .then((cf) => appStore.setState({ cloudflare: cf }))
      .catch(() => {})
    void window.boss
      .sitesList()
      .then((sites) => appStore.setState({ sites }))
      .catch(() => {})

    void window.boss.ttsStatus().then((st) => applySpeechStatus({ tts: st, asr: appStore.getState().asr }))

    void window.boss
      .serverInfo()
      .then((info) => {
        appStore.setState({
          serverUrl: info.url,
          serverVersion: info.version,
          serverHealthy: info.healthy
        })
        if (info.healthy) void refreshAll()
      })
      .catch(() => {})

    // BOSS owns the project list, so load it without waiting for a backend.
    // refreshAll only runs once opencode connects, which left added projects
    // saved to disk but never shown.
    void refreshProjects()

    void refreshOptional()
    void refreshProject()
    void window.boss
      .computerUseStatus()
      .then((st) => appStore.setState({ computerUse: st }))
      .catch(() => {})
    void window.boss
      .computerUsePermissions()
      .then((perms) => appStore.setState({ computerUsePerms: perms }))
      .catch(() => {})

    return () => {
      offEvent()
      offStatus()
      offProgress()
      offSpeech()
      offBrowseAgent()
      offSites()
      window.clearTimeout(refreshTimer)
      void window.boss.unsubscribeEvents()
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        const s = appStore.getState()
        const sid = s.activeSessionId
        if (sid && s.streaming[sid]) void abortRun(sid)
      }
    }
    const onFocus = (): void => {
      clearAttention()
      void window.boss.computerUsePermissions().then((perms) => appStore.setState({ computerUsePerms: perms }))
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  const attention = useStore(appStore, (s) => s.attention)
  useEffect(() => {
    document.title = attention
      ? `${attention.kind === 'permission' ? '⚠ ' : attention.kind === 'question' ? '? ' : attention.kind === 'error' ? '✕ ' : '✓ '}BOSS`
      : 'BOSS'
  }, [attention])

  // No standalone chat page: a chat is a thread, so it opens in a view like
  // any other. And the workspace stays mounted behind the other pages rather
  // than being swapped out — rendering it conditionally tore down every
  // terminal in it whenever you looked at Command Center, Automations or
  // Sites, and started them again on the way back.
  const overlay = (() => {
    if (activePage === 'command-center') return <CommandCenter />
    if (activePage === 'automations') return <AutomationsPage />
    if (activePage === 'sites') return <SitesPage />
    return null
  })()

  return (
    <div className="app">
      <Sidebar />
      <div className="main">
        <UpdateBanner />
        {/* Above the pages, not inside one: the attention pill and any
            degraded-service warning apply wherever you are. */}
        <Toolbar />
        <div className="page-layer" hidden={Boolean(overlay)}><Workspace /></div>
        {overlay}
      </div>
      <ModelSwitchModal />
      <CommitDialog />
      <RenameModal />
      <ConfirmModal />
      <DelegateModal />
      <TaskPolicyModal />
      <SettingsModal />
    </div>
  )
}
