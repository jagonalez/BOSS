import assert from 'node:assert/strict'
import test from 'node:test'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error Application code uses bundler resolution.
import {
  ACTIVITY_FEED_CAP,
  activityReducer,
  formatRelativeTime,
  parseActivityFeed,
  serializeActivityFeed,
  unreadCount,
  type ActivityEvent,
  type ActivityFeedState
} from './activity-feed.ts'

function event(overrides: Partial<ActivityEvent>): ActivityEvent {
  return { id: 'e1', kind: 'permission', ts: 1000, ...overrides }
}

function feed(events: ActivityEvent[], lastReadTs = 0): ActivityFeedState {
  return { events, lastReadTs }
}

test('a recorded event lands newest first', () => {
  const first = event({ id: 'a', ts: 1000 })
  const second = event({ id: 'b', kind: 'done', ts: 2000 })
  const state = activityReducer(feed([first]), { type: 'record', event: second })
  assert.deepEqual(state.events.map((item) => item.id), ['b', 'a'])
})

test('repeating a kind for a thread while unread updates the entry instead of stacking', () => {
  const asked = event({ id: 'a', kind: 'permission', ts: 1000, sessionId: 's1' })
  const again = event({ id: 'b', kind: 'permission', ts: 2000, sessionId: 's1' })
  const state = activityReducer(feed([asked]), { type: 'record', event: again })
  assert.equal(state.events.length, 1)
  assert.equal(state.events[0].ts, 2000)
})

test('updating an unread entry moves it back to the front', () => {
  const permission = event({ id: 'a', kind: 'permission', ts: 1000, sessionId: 's1' })
  const question = event({ id: 'b', kind: 'question', ts: 1500, sessionId: 's2' })
  const updated = event({ id: 'c', kind: 'permission', ts: 2000, sessionId: 's1' })
  const state = activityReducer(feed([question, permission]), { type: 'record', event: updated })
  assert.deepEqual(state.events.map((item) => item.id), ['a', 'b'])
  assert.deepEqual(state.events.map((item) => item.ts), [2000, 1500])
})

test('the same kind records fresh once the earlier entry was read', () => {
  const read = event({ id: 'a', kind: 'error', ts: 1000, sessionId: 's1' })
  const next = event({ id: 'b', kind: 'error', ts: 5000, sessionId: 's1' })
  const state = activityReducer(feed([read], 2000), { type: 'record', event: next })
  assert.deepEqual(state.events.map((item) => item.id), ['b', 'a'])
})

test('different kinds for one thread do not collapse into each other', () => {
  const asked = event({ id: 'a', kind: 'permission', ts: 1000, sessionId: 's1' })
  const question = event({ id: 'b', kind: 'question', ts: 1500, sessionId: 's1' })
  const state = activityReducer(feed([asked]), { type: 'record', event: question })
  assert.equal(state.events.length, 2)
})

test('events beyond the cap drop the oldest, not the newest', () => {
  let state = feed([])
  for (let index = 0; index < ACTIVITY_FEED_CAP + 10; index++) {
    state = activityReducer(state, {
      type: 'record',
      event: event({ id: `e${index}`, ts: index + 1, sessionId: `s${index}` })
    })
  }
  assert.equal(state.events.length, ACTIVITY_FEED_CAP)
  assert.equal(state.events[0].id, `e${ACTIVITY_FEED_CAP + 9}`)
  assert.equal(state.events.at(-1)!.id, 'e10')
})

test('markAllRead clears every current event and never moves the watermark backwards', () => {
  const state = activityReducer(feed([event({ id: 'a', ts: 3000 }), event({ id: 'b', kind: 'done', ts: 1000 })]), {
    type: 'markAllRead',
    ts: 2000
  })
  assert.equal(unreadCount(state), 0)
  assert.equal(state.lastReadTs, 3000)
  const backwards = activityReducer({ events: [], lastReadTs: 9000 }, { type: 'markAllRead', ts: 1000 })
  assert.equal(backwards.lastReadTs, 9000)
})

test('unreadCount counts only entries newer than the watermark', () => {
  const state = feed([event({ id: 'a', ts: 3000 }), event({ id: 'b', ts: 2500 }), event({ id: 'c', ts: 1000 })], 2600)
  assert.equal(unreadCount(state), 1)
})

test('formatRelativeTime buckets without rounding up to the next unit early', () => {
  const now = Date.parse('2026-01-01T12:00:00Z')
  assert.equal(formatRelativeTime(now - 30_000, now), 'just now')
  assert.equal(formatRelativeTime(now - 59_999, now), 'just now')
  assert.equal(formatRelativeTime(now - 5 * 60_000, now), '5m ago')
  assert.equal(formatRelativeTime(now - 3 * 3_600_000, now), '3h ago')
  assert.equal(formatRelativeTime(now - 2 * 86_400_000, now), '2d ago')
})

test('a timestamp in the future reads as now rather than negative', () => {
  const now = Date.parse('2026-01-01T12:00:00Z')
  assert.equal(formatRelativeTime(now + 60_000, now), 'just now')
})

test('serialization round-trips through parsing', () => {
  const state = feed(
    [
      event({ id: 'a', kind: 'question', ts: 20, sessionId: 's1', threadTitle: 'Fix login', detail: 'Which branch?' }),
      event({ id: 'b', kind: 'done', ts: 10 })
    ],
    15
  )
  assert.deepEqual(parseActivityFeed(serializeActivityFeed(state)), state)
})

test('parsing survives corrupt JSON and junk entries by dropping them', () => {
  assert.deepEqual(parseActivityFeed(null), { events: [], lastReadTs: 0 })
  assert.deepEqual(parseActivityFeed('{not json'), { events: [], lastReadTs: 0 })
  assert.deepEqual(parseActivityFeed(JSON.stringify({ events: 'nope' })), { events: [], lastReadTs: 0 })
  const junk = JSON.stringify({
    events: [
      { id: 'keep', kind: 'done', ts: 30 },
      { id: 'x', kind: 'mystery', ts: 40 },
      { id: 'y', ts: 41 }
    ]
  })
  const parsed = parseActivityFeed(junk)
  assert.deepEqual(parsed.events.map((item) => item.id), ['keep'])
})
