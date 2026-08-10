import React, { useEffect } from 'react'
import { useStore, appStore, applyEvent } from './state/AppState'
import { Sidebar } from './components/Sidebar'
import { Toolbar } from './components/Toolbar'
import { ChatView } from './components/ChatView'
import { Panel, AddBar } from './components/Panel'
import { Footer } from './components/Footer'
import { PermissionModal } from './components/PermissionModal'
import {
  refreshAgents,
  refreshConfig,
  refreshDiff,
  refreshOptional,
  refreshProject,
  refreshProjects,
  refreshProviders,
  refreshSessions,
  loadMessages,
  loadTodos
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
  const panelWidth = useStore(appStore, (s) => s.panelWidth)
  const activeSessionId = useStore(appStore, (s) => s.activeSessionId)
  const activeTabKind = useStore(appStore, (s) => s.tabs.find((t) => t.id === s.activeTabId)?.kind)

  useEffect(() => {
    const saved = Number(localStorage.getItem('ralf.panelWidth'))
    if (Number.isFinite(saved) && saved >= 320) appStore.setState({ panelWidth: saved })
  }, [])

  useEffect(() => {
    localStorage.setItem('ralf.panelWidth', String(panelWidth))
  }, [panelWidth])

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
        case 'message.updated':
        case 'message.part.updated':
        case 'message.part.created':
          window.clearTimeout(refreshTimer)
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

    const offBrowse = window.ralf.onBrowseNavigation((state) => {
      appStore.setState({ browse: state })
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
      offBrowse()
      offProgress()
      window.clearTimeout(refreshTimer)
      void window.ralf.unsubscribeEvents()
    }
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
    </div>
  )
}
