import React, { useEffect, useRef, useState } from 'react'
import type { BackendId } from '@shared/backend'
import { appStore, useStore } from '../state/AppState'
import { cloneThreadToBackend, relayThreadToThread, setEmptyThreadBackend, setNativeViewsSuspended } from '../lib/actions'
import { BACKEND_SHORT_LABELS } from '../lib/backend-labels'

export function BackendBadge({ backendId }: { backendId?: BackendId }): React.JSX.Element {
  const id = backendId ?? 'opencode'
  return <span className={`backend-badge backend-${id}`}>{BACKEND_SHORT_LABELS[id]}</span>
}

export function BackendControls({ sessionId }: { sessionId: string }): React.JSX.Element {
  const backends = useStore(appStore, (state) => state.backends)
  const sessions = useStore(appStore, (state) => state.sessions)
  const current = sessions.find((session) => session.id === sessionId)
  const backendId = current?.backendId ?? 'opencode'
  const blank = useStore(appStore, (state) =>
    !(state.messages[sessionId] ?? []).some((message) => message.info.role === 'user')
  )
  const [menu, setMenu] = useState<'backend' | 'relay' | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menu) return
    const close = (event: MouseEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) setMenu(null)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menu])

  useEffect(() => {
    const reason = `backend-controls-${sessionId}`
    setNativeViewsSuspended(reason, Boolean(menu))
    return () => setNativeViewsSuspended(reason, false)
  }, [menu, sessionId])

  const chooseBackend = (target: BackendId): void => {
    setMenu(null)
    if (target === backendId) return
    const label = BACKEND_SHORT_LABELS[target]
    if (blank) {
      void setEmptyThreadBackend(sessionId, target)
      return
    }
    appStore.setState({
      confirm: {
        title: `Continue in ${label}?`,
        message: `R.A.L.F. will create a new ${label} thread with a bounded handoff of this conversation. The original ${BACKEND_SHORT_LABELS[backendId]} thread remains unchanged.`,
        confirmLabel: `Continue in ${label}`,
        action: () => void cloneThreadToBackend(sessionId, target)
      }
    })
  }

  const targets = sessions.filter((session) => session.id !== sessionId && !session.parentID)

  return (
    <div className="backend-controls" ref={ref}>
      <button className="backend-control-button" onClick={() => setMenu((value) => value === 'backend' ? null : 'backend')} title="Thread backend">
        <BackendBadge backendId={backendId} /><span className="backend-chevron">⌄</span>
      </button>
      <button
        className="backend-control-button relay"
        disabled={blank}
        onClick={() => setMenu((value) => value === 'relay' ? null : 'relay')}
        title={blank ? 'Send a message first to create context for another thread' : "Send this thread's context to another thread"}
      >
        Send to…
      </button>
      {menu === 'backend' ? (
        <div className="backend-menu">
          <div className="workspace-menu-title">{blank ? 'Choose backend' : 'Continue this thread in'}</div>
          {backends.map((backend) => (
            <button
              key={backend.id}
              disabled={!backend.available || backend.id === backendId}
              onClick={() => chooseBackend(backend.id)}
            >
              <BackendBadge backendId={backend.id} />
              <span className="backend-menu-copy"><strong>{backend.label}</strong><small>{backend.id === backendId ? (blank ? 'Selected backend' : 'Current backend') : backend.available ? backend.description : backend.unavailableReason}</small></span>
            </button>
          ))}
        </div>
      ) : null}
      {menu === 'relay' ? (
        <div className="backend-menu relay-menu">
          <div className="workspace-menu-title">Send a context handoff to</div>
          {targets.map((target) => (
            <button
              key={target.id}
              onClick={() => {
                setMenu(null)
                appStore.setState({
                  confirm: {
                    title: `Send context to “${target.title || 'Untitled'}”?`,
                    message: 'R.A.L.F. will send a bounded transcript and changed-file summary as a new message. The target agent may begin working immediately.',
                    confirmLabel: 'Send context',
                    action: () => void relayThreadToThread(sessionId, target.id)
                  }
                })
              }}
            >
              <BackendBadge backendId={target.backendId} />
              <span className="backend-menu-copy"><strong>{target.title || 'Untitled'}</strong><small>{(target.projectPath ?? target.directory ?? target.path) || 'Chat'}</small></span>
            </button>
          ))}
          {targets.length === 0 ? <div className="backend-menu-empty">No other threads in this project.</div> : null}
        </div>
      ) : null}
    </div>
  )
}
