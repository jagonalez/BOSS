/** The activity inbox's data model.
 *
 *  Attention on a thread is momentary — the pill clears the instant you look
 *  at the window. This keeps a capped, persisted history of those moments so
 *  something that happened while you were away is still findable. The reducer
 *  here is pure; localStorage lives at the edge of the module. */

export type ActivityKind =
  | 'permission'
  | 'permission.answered'
  | 'question'
  | 'question.answered'
  | 'question.rejected'
  | 'error'
  | 'done'

export const ACTIVITY_KINDS: readonly ActivityKind[] = [
  'permission',
  'permission.answered',
  'question',
  'question.answered',
  'question.rejected',
  'error',
  'done'
]

export interface ActivityEvent {
  id: string
  kind: ActivityKind
  ts: number
  sessionId?: string
  threadTitle?: string
  detail?: string
}

export interface ActivityFeedState {
  /** Newest first. */
  events: ActivityEvent[]
  lastReadTs: number
}

export const ACTIVITY_FEED_CAP = 100

export type ActivityAction =
  | { type: 'record'; event: ActivityEvent }
  | { type: 'markAllRead'; ts: number }

export function isActivityKind(value: unknown): value is ActivityKind {
  return typeof value === 'string' && (ACTIVITY_KINDS as readonly string[]).includes(value)
}

function dedupeKey(event: ActivityEvent): string {
  return `${event.kind}:${event.sessionId ?? ''}`
}

/** Fold an event into the feed.
 *
 *  Repeating a kind for one thread — a second `permission.asked` while the
 *  first is still unread, say — updates the entry instead of stacking rows,
 *  so the badge counts things to look at rather than arrivals. Once read, the
 *  same kind records fresh. */
export function activityReducer(state: ActivityFeedState, action: ActivityAction): ActivityFeedState {
  switch (action.type) {
    case 'markAllRead': {
      const newestTs = state.events.reduce((latest, event) => Math.max(latest, event.ts), 0)
      return { events: state.events, lastReadTs: Math.max(state.lastReadTs, action.ts, newestTs) }
    }
    case 'record': {
      if (!isActivityKind(action.event.kind)) return state
      const key = dedupeKey(action.event)
      const pendingIndex = state.events.findIndex(
        (event) => event.ts > state.lastReadTs && dedupeKey(event) === key
      )
      let events: ActivityEvent[]
      if (pendingIndex >= 0) {
        const current = state.events[pendingIndex]
        const updated = {
          ...current,
          ts: action.event.ts,
          threadTitle: action.event.threadTitle ?? current.threadTitle,
          detail: action.event.detail ?? current.detail
        }
        events = [updated, ...state.events.filter((_, index) => index !== pendingIndex)]
      } else {
        events = [action.event, ...state.events]
      }
      return { events: events.slice(0, ACTIVITY_FEED_CAP), lastReadTs: state.lastReadTs }
    }
  }
}

export function unreadCount(state: ActivityFeedState): number {
  return state.events.filter((event) => event.ts > state.lastReadTs).length
}

/** A compact age for a row: "just now", "5m ago", "3h ago", "2d ago". */
export function formatRelativeTime(ts: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - ts) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

const STORAGE_KEY = 'boss.activity'

export function serializeActivityFeed(state: ActivityFeedState): string {
  return JSON.stringify({ events: state.events.slice(0, ACTIVITY_FEED_CAP), lastReadTs: state.lastReadTs })
}

/** Parse stored JSON defensively: a truncated or hand-edited entry must cost
 *  the history, not the session. */
export function parseActivityFeed(raw: string | null): ActivityFeedState {
  if (!raw) return { events: [], lastReadTs: 0 }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { events?: unknown }).events)) {
      return { events: [], lastReadTs: 0 }
    }
    const source = parsed as { events: unknown[]; lastReadTs?: unknown }
    const events = source.events
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .filter((item) => isActivityKind(item.kind) && typeof item.id === 'string' && typeof item.ts === 'number')
      .map((item) => {
        const event: ActivityEvent = { id: item.id as string, kind: item.kind as ActivityKind, ts: item.ts as number }
        if (typeof item.sessionId === 'string') event.sessionId = item.sessionId
        if (typeof item.threadTitle === 'string') event.threadTitle = item.threadTitle
        if (typeof item.detail === 'string') event.detail = item.detail
        return event
      })
      .sort((a, b) => b.ts - a.ts)
      .slice(0, ACTIVITY_FEED_CAP)
    const lastReadTs = typeof source.lastReadTs === 'number' ? source.lastReadTs : 0
    return { events, lastReadTs }
  } catch {
    return { events: [], lastReadTs: 0 }
  }
}

export function loadActivityFeed(): ActivityFeedState {
  try {
    return parseActivityFeed(localStorage.getItem(STORAGE_KEY))
  } catch {
    return { events: [], lastReadTs: 0 }
  }
}

export function saveActivityFeed(state: ActivityFeedState): void {
  try {
    localStorage.setItem(STORAGE_KEY, serializeActivityFeed(state))
  } catch {
    /* The in-memory feed still applies for this run. */
  }
}
