import React, { useEffect } from 'react'
import { useStore, appStore, applyEvent } from './state/AppState'
import { Sidebar } from './components/Sidebar'
import { Toolbar } from './components/Toolbar'
import { ChatView } from './components/ChatView'
import { Footer } from './components/Footer'
import { Workspace } from './components/Workspace'
import { CommandCenter, EmptyProductPage } from './components/CommandCenter'
import { ModelSwitchModal } from './components/ModelSwitchModal'
import { applyTheme, loadTheme } from './lib/themes'
import { CommitDialog } from './components/CommitDialog'
import { RenameModal } from './components/RenameModal'
import { ConfirmModal } from './components/ConfirmModal'
import { SettingsModal } from './components/SettingsModal'
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
  const workspaceProjectKey = useStore(appStore, (s) => s.projectWorkspace?.projectKey)
  const modalOpen = useStore(appStore, (s) => Boolean(s.settingsOpen || s.confirm || s.modelSwitch || s.commitPath || s.renameTarget))

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

  useEffect(() => {
    if (!projectPath || workspaceProjectKey === projectPath) return
    const preferred = sessions.find((session) => (session.directory || session.path) === projectPath)?.id
    loadProjectWorkspace(projectPath, preferred)
  }, [projectPath, sessions, workspaceProjectKey])

  useEffect(() => {
    if (projectPath) void refreshThreadBus()
  }, [projectPath])

  useEffect(() => {
    setNativeViewsSuspended('app-modal', modalOpen)
    return () => setNativeViewsSuspended('app-modal', false)
  }, [modalOpen])

  useEffect(() => {
    let refreshTimer: number | undefined

    document.documentElement.dataset.platform = window.ralf.platform()
    void window.ralf.subscribeEvents()

    const offEvent = window.ralf.onEvent((data) => {
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
          if (mode !== 'ask') {
            if (props.sessionID) {
              appStore.setState((st) => {
                const permissions = { ...st.permissions }
                delete permissions[props.sessionID!]
                return { permissions }
              })
            }
            if (props.sessionID && props.id) {
              void autoRespond(props.sessionID, props.id, mode === 'auto' ? 'once' : 'reject')
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
        default:
          break
      }
    })

    const offStatus = window.ralf.onServerStatusChanged((info) => {
      appStore.setState({
        serverUrl: info.url,
        serverVersion: info.version,
        serverHealthy: info.healthy
      })
    })

    const offProgress = window.ralf.onOptionalProgress((evt) => {
      appStore.setState((s) => ({
        optionalProgress: { ...s.optionalProgress, [evt.id]: evt }
      }))
      if (evt.phase === 'done') void refreshOptional()
    })

    const offSpeech = window.ralf.onSpeechStatusChanged(applySpeechStatus)

    void window.ralf.ttsStatus().then((st) => applySpeechStatus({ tts: st, asr: appStore.getState().asr }))

    void window.ralf
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

    void refreshOptional()
    void refreshProject()
    void window.ralf
      .computerUseStatus()
      .then((st) => appStore.setState({ computerUse: st }))
      .catch(() => {})
    void window.ralf
      .computerUsePermissions()
      .then((perms) => appStore.setState({ computerUsePerms: perms }))
      .catch(() => {})

    return () => {
      offEvent()
      offStatus()
      offProgress()
      offSpeech()
      window.clearTimeout(refreshTimer)
      void window.ralf.unsubscribeEvents()
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
      void window.ralf.computerUsePermissions().then((perms) => appStore.setState({ computerUsePerms: perms }))
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
      ? `${attention.kind === 'permission' ? '⚠ ' : attention.kind === 'error' ? '✕ ' : '✓ '}R.A.L.F.`
      : 'R.A.L.F.'
  }, [attention])

  const page = (() => {
    if (activePage === 'command-center') return <CommandCenter />
    if (activePage === 'automations') return <EmptyProductPage title="Automations" description="Scheduled and recurring agent work will live here." />
    if (activePage === 'sites') return <EmptyProductPage title="Sites" description="Published project surfaces will live here." />
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
        {page}
        <Footer />
      </div>
      <ModelSwitchModal />
      <CommitDialog />
      <RenameModal />
      <ConfirmModal />
      <SettingsModal />
    </div>
  )
}
