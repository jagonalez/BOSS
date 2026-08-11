import React from 'react'
import type { SessionInfo } from '@shared/opencode'
import { useStore, appStore } from '../state/AppState'
import { openProject, selectSession } from '../lib/actions'
import { ChatIcon, ChevronIcon } from './icons'

function timeAgo(timestamp?: number): string {
  if (!timestamp) return 'recently'
  const diff = Date.now() - timestamp
  if (diff < 60_000) return 'now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

function projectName(session: SessionInfo): string {
  const path = session.directory || session.path || ''
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || 'Chat'
}

async function openSession(session: SessionInfo): Promise<void> {
  const path = session.directory || session.path || ''
  if (path && path !== '/' && path !== appStore.getState().projectPath) await openProject(path)
  selectSession(session.id)
}

function SessionCard({ session, state }: { session: SessionInfo; state: 'attention' | 'running' | 'recent' }): React.JSX.Element {
  const permission = useStore(appStore, (value) => Boolean(value.permissions[session.id]))
  const error = useStore(appStore, (value) => value.lastErrorBySession[session.id])
  const label = permission ? 'Permission needed' : error ? 'Run failed' : state === 'running' ? 'Working' : 'Updated'
  return (
    <button className="command-session-card" onClick={() => void openSession(session)}>
      <span className={`command-state-icon ${state}`}><ChatIcon size={14} /></span>
      <span className="command-session-main">
        <strong>{session.title || 'Untitled thread'}</strong>
        <small>{projectName(session)} · {label}</small>
      </span>
      <span className="command-session-time">{timeAgo(session.time?.updated)}</span>
      <ChevronIcon size={14} />
    </button>
  )
}

export function CommandCenter(): React.JSX.Element {
  const sessions = useStore(appStore, (state) => state.sessions.filter((session) => !session.parentID))
  const permissions = useStore(appStore, (state) => state.permissions)
  const questions = useStore(appStore, (state) => state.questions)
  const errors = useStore(appStore, (state) => state.lastErrorBySession)
  const streaming = useStore(appStore, (state) => state.streaming)
  const serverHealthy = useStore(appStore, (state) => state.serverHealthy)

  const ordered = [...sessions].sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
  const needsAttention = ordered.filter((session) => permissions[session.id] || questions[session.id] || errors[session.id])
  const running = ordered.filter((session) => streaming[session.id] && !needsAttention.includes(session))
  const recent = ordered.filter((session) => !streaming[session.id] && !needsAttention.includes(session)).slice(0, 6)

  return (
    <div className="command-center">
      <header className="command-header" onDoubleClick={() => void window.ralf.toggleMaximize()}>
        <div>
          <span className="command-eyebrow">Command Center</span>
          <h1>Here’s what’s happening.</h1>
          <p>Status is based on live R.A.L.F. events. An optional AI briefing can be layered on later.</p>
        </div>
        <div className={`command-connection ${serverHealthy ? 'connected' : ''}`}>
          <span />{serverHealthy ? 'Connected' : 'Connecting'}
        </div>
      </header>

      <div className="command-grid">
        <section className="command-section command-attention">
          <div className="command-section-head"><h2>Needs your attention</h2><span>{needsAttention.length}</span></div>
          <div className="command-list">
            {needsAttention.length > 0
              ? needsAttention.map((session) => <SessionCard key={session.id} session={session} state="attention" />)
              : <div className="command-empty">Nothing needs you right now.</div>}
          </div>
        </section>

        <section className="command-section">
          <div className="command-section-head"><h2>Running</h2><span>{running.length}</span></div>
          <div className="command-list">
            {running.length > 0
              ? running.map((session) => <SessionCard key={session.id} session={session} state="running" />)
              : <div className="command-empty">No agents are currently running.</div>}
          </div>
        </section>

        <section className="command-section command-recent">
          <div className="command-section-head"><h2>Recently active</h2><span>{recent.length}</span></div>
          <div className="command-list">
            {recent.length > 0
              ? recent.map((session) => <SessionCard key={session.id} session={session} state="recent" />)
              : <div className="command-empty">Your recent work will appear here.</div>}
          </div>
        </section>
      </div>
    </div>
  )
}

export function EmptyProductPage({ title, description }: { title: string; description: string }): React.JSX.Element {
  return (
    <div className="product-empty-page">
      <span className="command-eyebrow">R.A.L.F.</span>
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
  )
}
