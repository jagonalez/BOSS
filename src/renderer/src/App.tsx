import React, { useEffect } from 'react'
import { useStore, appStore, applyEvent, MAIN_MIN_WIDTH, SIDEBAR_FALLBACK_WIDTH } from './state/AppState'
import { Sidebar } from './components/Sidebar'
import { Toolbar } from './components/Toolbar'
import { ChatView } from './components/ChatView'
import { Panel, AddBar } from './components/Panel'
import { Footer } from './components/Footer'
import { PermissionModal } from './components/PermissionModal'
import { ModelSwitchModal } from './components/ModelSwitchModal'
import { CommitDialog } from './components/CommitDialog'
import { RenameModal } from './components/RenameModal'
import { ConfirmModal } from './components/ConfirmModal'
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
  loadArchived,
  loadSessionMeta,
  loadMessages,
  loadTodos,
  autoRespond,
  abortRun
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
          void refreshSessions()
          break
        case 'permission.updated': {
          const mode = appStore.getState().mode
          if (mode !== 'ask') {
            const props = (ev.properties ?? {}) as { sessionID?: string; id?: string }
            if (props.sessionID && props.id) {
              void autoRespond(props.sessionID, props.id, mode === 'auto' ? 'allowed' : 'rejected')
            }
            break
          }
          const patch = applyEvent(appStore.getState(), ev)
          if (Object.keys(patch).length > 0) appStore.setState(patch)
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

    return () => {
      offEvent()
      offStatus()
      offProgress()
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
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

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
      <PermissionModal />
      <ModelSwitchModal />
      <CommitDialog />
      <RenameModal />
      <ConfirmModal />
    </div>
  )
}
