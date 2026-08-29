import React, { useEffect, useMemo, useState } from 'react'
import type { SupervisedThread, SupervisionSnapshot } from '@shared/supervision'
import { descendantTaskNodes } from '@shared/task-tree'
import { appStore, useStore } from '../state/AppState'
import { selectSession } from '../lib/actions'
import { BACKEND_SHORT_LABELS } from '../lib/backend-labels'
import { OpenCode } from '../lib/opencode'
import { BackendBadge } from './BackendControls'
import { ChevronIcon, ForkIcon } from './icons'

function agentState(thread: SupervisedThread): { label: string; tone: 'attention' | 'working' | 'done' | 'idle' } {
  if (thread.attention?.kind === 'permission') return { label: 'Needs permission', tone: 'attention' }
  if (thread.attention?.kind === 'question') return { label: 'Needs an answer', tone: 'attention' }
  if (thread.attention?.kind === 'error' || thread.lastRun?.status === 'error' || thread.result?.status === 'error') {
    return { label: 'Failed', tone: 'attention' }
  }
  if (thread.running) return { label: 'Working', tone: 'working' }
  if (thread.attention?.kind === 'interrupted' || thread.lastRun?.status === 'interrupted' || thread.result?.status === 'interrupted') {
    return { label: 'Interrupted', tone: 'idle' }
  }
  if (thread.result?.status === 'completed' || thread.lastRun?.status === 'completed' || thread.attention?.kind === 'completed') {
    return { label: 'Completed', tone: 'done' }
  }
  return { label: 'Idle', tone: 'idle' }
}

function relationship(thread: SupervisedThread): string {
  switch (thread.lineage?.kind) {
    case 'delegate': return 'Delegate'
    case 'fork': return 'Fork'
    case 'clone': return 'Continued thread'
    case 'review': return 'Reviewer'
    case 'relay': return 'Relay'
    case 'fallback': return 'Fallback'
    default: return 'Native subagent'
  }
}

export function AgentsTab({ sessionId, active }: { sessionId: string; active: boolean }): React.JSX.Element {
  const owner = useStore(appStore, (state) => state.sessions.find((session) => session.id === sessionId))
  const knownSessionIds = useStore(appStore, (state) => new Set(state.sessions.map((session) => session.id)))
  const [snapshot, setSnapshot] = useState<SupervisionSnapshot | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!active) return
    let disposed = false
    const refresh = (): void => {
      void OpenCode.supervision().then((value) => {
        if (disposed) return
        setSnapshot(value)
        setFailed(false)
      }).catch(() => {
        if (!disposed) setFailed(true)
      })
    }
    refresh()
    const timer = window.setInterval(refresh, 5_000)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [active, sessionId])

  const agents = useMemo(
    () => descendantTaskNodes(snapshot?.threads ?? [], sessionId),
    [snapshot, sessionId]
  )
  const title = owner?.title || 'this thread'

  return (
    <section className="agents-tab" aria-label={`Agents for ${title}`}>
      <header className="agents-tab-header">
        <span className="agents-tab-mark"><ForkIcon size={18} /></span>
        <span>
          <strong>Agents for {title}</strong>
          <small>{agents.length} subagent{agents.length === 1 ? '' : 's'} across all backends</small>
        </span>
      </header>

      {failed && !snapshot ? (
        <div className="agents-tab-empty error">Could not load agent activity.</div>
      ) : !snapshot ? (
        <div className="agents-tab-empty">Loading agents…</div>
      ) : agents.length === 0 ? (
        <div className="agents-tab-empty">
          <ForkIcon size={24} />
          <strong>No subagents yet</strong>
          <span>Delegates and backend-native child agents spawned from this thread will appear here.</span>
        </div>
      ) : (
        <div className="agents-list">
          {agents.map(({ thread, depth }) => {
            const state = agentState(thread)
            const canOpen = knownSessionIds.has(thread.threadId)
            const files = thread.result?.changedFiles
            return (
              <article
                key={thread.threadId}
                className={`agent-card ${depth === 0 ? 'root' : ''}`}
                style={{ '--agent-depth': Math.min(depth, 5) } as React.CSSProperties}
                aria-label={`${thread.title}, ${BACKEND_SHORT_LABELS[thread.backendId]}, ${state.label}`}
              >
                <div className="agent-card-line" aria-hidden="true" />
                <div className="agent-card-main">
                  <div className="agent-card-heading">
                    <strong>{thread.title}</strong>
                    <span className={`agent-status ${state.tone}`}>{state.label}</span>
                  </div>
                  <div className="agent-card-meta">
                    <BackendBadge backendId={thread.backendId} />
                    <span>{relationship(thread)}</span>
                    {thread.worktreeBranch ? <span>{thread.worktreeBranch}</span> : null}
                    {files !== undefined ? <span>{files} file{files === 1 ? '' : 's'} changed</span> : null}
                  </div>
                  {thread.result?.summary ? <p>{thread.result.summary}</p> : null}
                </div>
                <button
                  className="agent-open"
                  disabled={!canOpen}
                  title={canOpen ? `Open ${thread.title}` : 'This native child has not been imported as a BOSS thread yet'}
                  onClick={() => selectSession(thread.threadId)}
                >
                  <span>Open thread</span>
                  <ChevronIcon size={14} />
                </button>
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}
