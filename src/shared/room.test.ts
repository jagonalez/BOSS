import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Application code uses bundler resolution.
import { PARTICIPANT_STALE_AFTER_MS, ROOM_ASSISTANT_ID, ROOM_EVERYONE, addressable, emptyRoomState, findParticipant, isRoomShape, participantIsStale, resolveMention, stripLeadingMention } from './room.ts'
import type { RoomParticipant, RoomState } from './room.ts'

function participant(overrides: Partial<RoomParticipant> = {}): RoomParticipant {
  return {
    roleId: 'builder',
    label: 'Builder',
    backendId: 'codex',
    state: 'active',
    joinedAt: 0,
    ...overrides
  }
}

function room(participants: RoomParticipant[]): RoomState {
  return { ...emptyRoomState(), participants }
}

test('a new room addresses BOSS, because it is the only participant that always exists', () => {
  const state = emptyRoomState()
  assert.equal(state.recipient, ROOM_ASSISTANT_ID, 'a room with no roles yet can still be talked to')
  assert.deepEqual(state.participants, [], 'roles join when the work reaches them, not up front')
})

test('a mention resolves against the label the user chose, whatever its case', () => {
  const state = room([participant({ roleId: 'r1', label: 'Builder' })])
  assert.equal(resolveMention(state, '@Builder'), 'r1')
  assert.equal(resolveMention(state, 'builder'), 'r1')
  assert.equal(resolveMention(state, '@BUILDER'), 'r1')
})

test('a mention resolves against a role id when the label differs', () => {
  const state = room([participant({ roleId: 'builder', label: 'Codey McCodeface' })])
  assert.equal(resolveMention(state, '@builder'), 'builder', 'the id stays addressable')
  assert.equal(
    resolveMention(state, 'Codey McCodeface'),
    'builder',
    'a two-word role name still resolves, because the user chose it'
  )
})

test('BOSS and everyone resolve without joining the room', () => {
  const state = room([])
  assert.equal(resolveMention(state, '@boss'), ROOM_ASSISTANT_ID, 'BOSS is reachable from any room')
  assert.equal(resolveMention(state, '@everyone'), ROOM_EVERYONE)
})

test('an unknown mention resolves to nothing rather than guessing', () => {
  const state = room([participant({ roleId: 'builder', label: 'Builder' })])
  assert.equal(resolveMention(state, '@reviewer'), undefined, 'addressing the wrong agent is worse than asking again')
  assert.equal(resolveMention(state, '@'), undefined)
  assert.equal(resolveMention(state, '   '), undefined)
})

test('a leading mention is stripped, because the chip already carries the recipient', () => {
  assert.equal(stripLeadingMention('@builder fix the header'), 'fix the header')
  assert.equal(stripLeadingMention('@builder, fix the header'), 'fix the header')
  assert.equal(stripLeadingMention('@builder: fix the header'), 'fix the header')
  assert.equal(stripLeadingMention('  @boss what happened'), 'what happened')
})

test('a mention inside a sentence stays, because it is prose the agent should read', () => {
  assert.equal(
    stripLeadingMention('tell @reviewer it is ready'),
    'tell @reviewer it is ready',
    'only the address is removed, never the content'
  )
})

test('a participant goes stale after an hour idle, so its old context is never resent', () => {
  const now = 10_000_000
  const fresh = participant({ lastActiveAt: now - 1000 })
  const old = participant({ lastActiveAt: now - PARTICIPANT_STALE_AFTER_MS - 1 })
  assert.equal(participantIsStale(fresh, now), false)
  assert.equal(participantIsStale(old, now), true)
})

test('a participant that never spoke is not stale, because it has no context to drop', () => {
  const now = 10_000_000
  assert.equal(participantIsStale(participant({ state: 'active' }), now), false)
})

test('a finished participant never goes stale, because it already left', () => {
  const now = 10_000_000
  const finished = participant({ state: 'done', lastActiveAt: now - PARTICIPANT_STALE_AFTER_MS * 100 })
  assert.equal(participantIsStale(finished, now), false, 'its notes remain either way')
})

test('addressable hides participants that have finished', () => {
  const state = room([
    participant({ roleId: 'builder', state: 'done' }),
    participant({ roleId: 'reviewer', state: 'working' })
  ])
  assert.deepEqual(
    addressable(state).map((entry) => entry.roleId),
    ['reviewer']
  )
})

test('a stale participant stays addressable, because addressing it starts a fresh one', () => {
  const state = room([participant({ roleId: 'planner', state: 'stale' })])
  assert.deepEqual(
    addressable(state).map((entry) => entry.roleId),
    ['planner'],
    'the user should not have to know the session was dropped'
  )
})

test('findParticipant returns nothing for a role that has not joined', () => {
  const state = room([participant({ roleId: 'builder' })])
  assert.equal(findParticipant(state, 'builder')?.label, 'Builder')
  assert.equal(findParticipant(state, 'reviewer'), undefined)
})

test('only the three named shapes are accepted', () => {
  assert.equal(isRoomShape('direct'), true)
  assert.equal(isRoomShape('reviewed'), true)
  assert.equal(isRoomShape('full'), true)
  assert.equal(isRoomShape('quick'), false)
  assert.equal(isRoomShape(undefined), false)
})
