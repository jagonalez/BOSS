import React from 'react'
import { appStore, useStore } from '../state/AppState'
import { formatRelativeTime, unreadCount, type ActivityKind } from '../lib/activity-feed'
import { markAllActivityRead, selectSession } from '../lib/actions'
import { BellIcon } from './icons'

/** What each kind says on a row, and which accent colours its dot. */
const KIND_LABELS: Record<ActivityKind, string> = {
  permission: 'Permission asked',
  'permission.answered': 'Permission answered',
  question: 'Question asked',
  'question.answered': 'Answer sent',
  'question.rejected': 'Question dismissed',
  error: 'Run failed',
  done: 'Run finished'
}

const KIND_TONES: Record<ActivityKind, string> = {
  permission: 'warning',
  'permission.answered': 'success',
  question: 'accent',
  'question.answered': 'success',
  'question.rejected': 'neutral',
  error: 'danger',
  done: 'success'
}

export function ActivityBell(): React.JSX.Element {
  const unread = useStore(appStore, (s) => unreadCount(s.activity))
  return (
    <button
      type="button"
      className={`inbox-bell ${unread > 0 ? 'has-unread' : ''}`}
      aria-label="Activity"
      onClick={() => appStore.setState((s) => ({ inboxOpen: !s.inboxOpen }))}
    >
      <BellIcon size={15} />
      {unread > 0 ? <span className="inbox-badge">{unread > 9 ? '9+' : unread}</span> : null}
    </button>
  )
}

export function ActivityPanel(): React.JSX.Element | null {
  const open = useStore(appStore, (s) => s.inboxOpen)
  const events = useStore(appStore, (s) => s.activity.events)
  const pending = useStore(appStore, (s) => unreadCount(s.activity))
  if (!open) return null

  return (
    <div className="inbox-panel" role="dialog" aria-label="Activity">
      <header className="inbox-head">
        <strong>Activity</strong>
        <button
          type="button"
          className="ui-button ui-button-secondary ui-button-small"
          disabled={pending === 0}
          onClick={markAllActivityRead}
        >
          Mark all read
        </button>
      </header>
      <ul className="inbox-list">
        {events.map((event) => (
          <li key={event.id}>
            <button
              type="button"
              className="inbox-row"
              onClick={() => {
                appStore.setState({ inboxOpen: false })
                if (event.sessionId) selectSession(event.sessionId)
              }}
            >
              <span className={`inbox-dot ${KIND_TONES[event.kind]}`} />
              <span className="inbox-row-copy">
                <span className="inbox-row-title">{KIND_LABELS[event.kind]}</span>
                <span className="inbox-row-detail">
                  {event.threadTitle ? `${event.threadTitle} · ` : ''}
                  {event.detail ? `${event.detail} · ` : ''}
                  {formatRelativeTime(event.ts, Date.now())}
                </span>
              </span>
            </button>
          </li>
        ))}
        {events.length === 0 ? <li className="inbox-empty">Nothing yet. Finished runs, questions and errors land here.</li> : null}
      </ul>
    </div>
  )
}
