import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Application code uses bundler resolution.
import { catchUpFor, catchUpPrompt, deliveryFor, splitBranches } from './room-routing.ts'
// @ts-expect-error Application code uses bundler resolution.
import { ROOM_ASSISTANT_ID, ROOM_EVERYONE, emptyRoomState } from './room.ts'
import type { MessageWithParts } from './opencode'
import type { RoomParticipant, RoomState } from './room'

function participant(overrides: Partial<RoomParticipant> = {}): RoomParticipant {
  return { roleId: 'builder', label: 'Builder', backendId: 'codex', state: 'active', joinedAt: 0, ...overrides }
}

function room(participants: RoomParticipant[]): RoomState {
  return { ...emptyRoomState(), participants }
}

function message(
  id: string,
  role: 'user' | 'assistant',
  text: string,
  extra: { at?: number; author?: string; recipient?: string; branchOf?: string } = {}
): MessageWithParts {
  return {
    info: {
      id,
      sessionID: 'room-1',
      role,
      ...(extra.at !== undefined ? { time: { created: extra.at } } : {}),
      ...(extra.author ? { author: extra.author } : {}),
      ...(extra.recipient ? { recipient: extra.recipient } : {}),
      ...(extra.branchOf ? { branchOf: extra.branchOf } : {})
    },
    parts: [{ id: `${id}-p`, type: 'text', sessionID: 'room-1', messageID: id, text }]
  }
}

test('a message addressed to one participant reaches only that one', () => {
  const state = room([participant({ roleId: 'builder' }), participant({ roleId: 'reviewer' })])
  assert.deepEqual(deliveryFor(state, 'builder'), { roleIds: ['builder'], broadcast: false })
})

test('BOSS is reachable from a room with no participants at all', () => {
  assert.deepEqual(deliveryFor(room([]), ROOM_ASSISTANT_ID), { roleIds: [ROOM_ASSISTANT_ID], broadcast: false })
})

test('a broadcast reaches every participant that has not left', () => {
  const state = room([
    participant({ roleId: 'builder' }),
    participant({ roleId: 'reviewer' }),
    participant({ roleId: 'planner', state: 'done' })
  ])
  const delivery = deliveryFor(state, ROOM_EVERYONE)
  assert.deepEqual(delivery.roleIds, ['builder', 'reviewer'], 'a participant that left is not asked')
  assert.equal(delivery.broadcast, true)
})

test('addressing a participant that has left reaches nobody rather than guessing', () => {
  const state = room([participant({ roleId: 'builder', state: 'done' })])
  assert.deepEqual(deliveryFor(state, 'builder').roleIds, [])
})

test('a stale participant is still addressed, because addressing it starts a fresh one', () => {
  const state = room([participant({ roleId: 'planner', state: 'stale' })])
  assert.deepEqual(deliveryFor(state, 'planner').roleIds, ['planner'])
})

test('a participant that never spoke catches up on the whole room', () => {
  const messages = [message('m1', 'user', 'hello', { at: 10 })]
  const result = catchUpFor(messages, undefined, 100)
  assert.equal(result.first, true)
  assert.equal(result.missed.length, 1)
})

test('a participant catches up only on what it missed, not the whole room again', () => {
  const messages = [
    message('m1', 'user', 'first', { at: 10 }),
    message('m2', 'assistant', 'reply', { at: 20, author: 'builder' }),
    message('m3', 'user', 'to boss', { at: 30, recipient: 'boss' }),
    message('m4', 'user', 'to you', { at: 40, recipient: 'builder' })
  ]
  const result = catchUpFor(messages, participant({ lastActiveAt: 20 }), 100)
  assert.deepEqual(
    result.missed.map((entry) => entry.info.id),
    ['m3', 'm4'],
    'several participants must not mean several copies of every message'
  )
  assert.equal(result.first, false)
})

test('catch-up ignores messages that arrive after the moment of addressing', () => {
  const messages = [message('m1', 'user', 'now', { at: 50 }), message('m2', 'user', 'later', { at: 500 })]
  const result = catchUpFor(messages, participant({ lastActiveAt: 10 }), 100)
  assert.deepEqual(result.missed.map((entry) => entry.info.id), ['m1'])
})

test('a caught-up participant is told to read but not act', () => {
  const prompt = catchUpPrompt([message('m1', 'user', 'this is wrong', { at: 10, recipient: 'boss' })], 'builder')
  assert.match(prompt, /Do not act on them/, 'thinking out loud with BOSS must not become an instruction')
  assert.match(prompt, /to boss/, 'the builder can see who was actually being addressed')
})

test('catch-up names the agent that spoke, so two agents never merge into one voice', () => {
  const prompt = catchUpPrompt([message('m1', 'assistant', 'done', { at: 10, author: 'reviewer' })], 'builder')
  assert.match(prompt, /reviewer: done/)
})

test('an empty catch-up produces nothing rather than a bare heading', () => {
  assert.equal(catchUpPrompt([], 'builder'), '')
})

test('branch replies are kept out of the main stream', () => {
  const messages = [
    message('m1', 'assistant', 'review found two things', { at: 10, author: 'reviewer' }),
    message('m2', 'user', 'why storage?', { at: 20, branchOf: 'm1' }),
    message('m3', 'assistant', 'i assumed', { at: 30, author: 'builder', branchOf: 'm1' }),
    message('m4', 'user', 'next point', { at: 40 })
  ]
  const { main, branches } = splitBranches(messages)
  assert.deepEqual(main.map((entry) => entry.info.id), ['m1', 'm4'])
  assert.deepEqual(branches.get('m1')?.map((entry) => entry.info.id), ['m2', 'm3'])
})

test('a room with no branches leaves the stream untouched', () => {
  const messages = [message('m1', 'user', 'hi', { at: 10 })]
  const { main, branches } = splitBranches(messages)
  assert.equal(main.length, 1)
  assert.equal(branches.size, 0)
})
