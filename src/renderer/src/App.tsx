import React, { useEffect } from 'react'
import { useStore, appStore, applyEvent, MAIN_MIN_WIDTH, SIDEBAR_FALLBACK_WIDTH } from './state/AppState'
import { Sidebar } from './components/Sidebar'
import { Toolbar } from './components/Toolbar'
import { ChatView } from './components/ChatView'
import { Panel, AddBar } from './components/Panel'
import { Footer } from './components/Footer'
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
  refreshStreaming,
  loadMode,
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
  loadEngine
} from './lib/actions'

async function refreshAll(): Promise<void> {
  void refreshSessions()
  void refreshProjects()
  void refreshProviders()
  void refreshAgents()
  void refreshConfig()
  const id = appStore.getState().activeSessionId
  if (id) {
    void loadMessages(id)
    void loadTodos(id)
    void refreshDiff(id)
  }
}

export function App(): React.JSX.Element {
  const panelOpen = useStore(appStore, (s) => s.panelOpen)
  const activeSessionId = useStore(appStore, (s) => s.activeSessionId)
  const activeTabKind = useStore(appStore, (s) => s.panelGroups[0]?.tabs.find((t) => t.id === s.panelGroups[0]?.activeTabId)?.kind)

  useEffect(() => {
    loadArchived()
    loadMode()
    loadAgent()
    loadSessionMeta()
    loadVariant()
    loadSpeechPrefs()
    loadEngine()
    applyTheme(loadTheme())
  }, [])

  useEffect(() => {
    const onResize = (): void => {
      const sidebarWidth = document.querySelector('.sidebar')?.getBoundingClientRect().width ?? SIDEBAR_FALLBACK_WIDTH
      const max = Math.max(300, window.innerWidth - sidebarWidth - MAIN_MIN_WIDTH - 8)
      appStore.setState((s) => ({
        panelGroups: s.panelGroups.map((g) => (g.width > max ? { ...g, width: max } : g))
      }))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

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
          const wasStreaming = appStore.getState().streaming
          refreshStreaming()
          if (wasStreaming && !appStore.getState().streaming && !document.hasFocus()) {
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
          const mode = appStore.getState().mode
          const props = (ev.properties ?? {}) as { sessionID?: string; id?: string }
          if (mode !== 'ask') {
            appStore.setState({ permission: null })
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
          refreshStreaming()
          refreshTimer = window.setTimeout(() => {
            const id = appStore.getState().activeSessionId
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
        if (s.streaming && s.activeSessionId) void abortRun()
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
      ? `${attention.kind === 'permission' ? '⚠ ' : attention.kind === 'error' ? '✕ ' : '✓ '}Ralf`
      : 'Ralf'
  }, [attention])

  useEffect(() => {
    if (activeTabKind === 'review' && panelOpen) void refreshDiff(activeSessionId)
  }, [activeTabKind, panelOpen, activeSessionId])
  return (
    <div className="app">
      <Sidebar />
      <div className="main">
        <Toolbar />
        <div className="content">
          <ChatView />
        </div>
        <Footer />
      </div>
      {panelOpen ? <Panel /> : <AddBar />}
      <ModelSwitchModal />
      <CommitDialog />
      <RenameModal />
      <ConfirmModal />
      <SettingsModal />
    </div>
  )
}
