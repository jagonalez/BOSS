import React, { useEffect } from 'react'
import { useStore, appStore, applyEvent } from './state/AppState'
import { Sidebar } from './components/Sidebar'
import { Toolbar } from './components/Toolbar'
import { ChatView } from './components/ChatView'
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
  refreshStreaming,
  loadMode,
  loadThreadPreferences,
  loadAgent,
  loadVariant,
  loadArchived,
  loadSessionMeta,
  loadMessages,
  loadTodos,
  autoRespond,
  abortRun,
  setAttention,
  clearAttention,
  loadSpeechPrefs,
  applySpeechStatus,
  loadEngine,
  initializeWorkspaceState,
  loadProjectWorkspace,
  setNativeViewsSuspended,
  modeForSession
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
            finalizeStalledParts(sid)
            // Idle is the authoritative completion edge. Refreshing here also
            // recovers the final response when intermediate backend events
            // were missed during a reconnect or directory change.
            void loadMessages(sid)
            void loadTodos(sid)
          }
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
          const props = (ev.properties ?? {}) as { sessionID?: string; id?: string }
          const mode = modeForSession(props.sessionID)
          const session = appStore.getState().sessions.find((item) => item.id === props.sessionID)
          const backend = appStore.getState().backends.find((item) => item.id === session?.backendId)
          const hostAutoResponse = mode === 'plan'
            ? 'reject'
            : mode === 'auto' && !backend?.capabilities.nativeAutoMode
              ? 'once'
              : undefined
          if (hostAutoResponse) {
            if (props.sessionID) {
              appStore.setState((st) => {
                const permissions = { ...st.permissions }
                delete permissions[props.sessionID!]
                return { permissions }
              })
            }
            if (props.sessionID && props.id) {
              void autoRespond(props.sessionID, props.id, hostAutoResponse)
            }
            break
          }
          const patch = applyEvent(appStore.getState(), ev)
          if (Object.keys(patch).length > 0) appStore.setState(patch)
          setAttention('permission')
          break
        }
        case 'question.asked': {
          const patch = applyEvent(appStore.getState(), ev)
          if (Object.keys(patch).length > 0) appStore.setState(patch)
          setAttention('permission')
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
      ? `${attention.kind === 'permission' ? '⚠ ' : attention.kind === 'error' ? '✕ ' : '✓ '}BOSS`
      : 'BOSS'
  }, [attention])

  const page = (() => {
    if (activePage === 'command-center') return <CommandCenter />
    if (activePage === 'automations') return <AutomationsPage />
    if (activePage === 'sites') return <SitesPage />
    if (activePage === 'project') return <Workspace />
    return (
      <>
        <Toolbar />
        <div className="content"><ChatView /></div>
      </>
    )
  })()

  return (
    <div className="app">
      <Sidebar />
      <div className="main">
        <UpdateBanner />
        {page}
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
