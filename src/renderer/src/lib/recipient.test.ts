import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Application code uses bundler resolution.
import { overrideFor, recipientKind, recipientLabel, recipientOptions, recipientProblem, retarget, splitOverride } from './recipient.ts'
// @ts-expect-error Application code uses bundler resolution.
import { ROOM_ASSISTANT_ID, ROOM_EVERYONE, emptyRoomState } from '../../../shared/room.ts'
import type { RoomParticipant, RoomState } from '../../../shared/room.ts'

function participant(overrides: Partial<RoomParticipant> = {}): RoomParticipant {
  return { roleId: 'builder', label: 'Builder', backendId: 'codex', state: 'active', joinedAt: 0, ...overrides }
}

function room(participants: RoomParticipant[]): RoomState {
  return { ...emptyRoomState(), participants }
}

test('a room with nobody in it can still address BOSS and everyone', () => {
  const options = recipientOptions(room([]))
  assert.deepEqual(
    options.map((option) => option.id),
    [ROOM_ASSISTANT_ID, ROOM_EVERYONE],
    'an empty room is talkable, because BOSS is always there'
  )
})

test('participants come before BOSS, because they are what the user is working with', () => {
  const options = recipientOptions(room([participant({ roleId: 'builder' })]))
  assert.equal(options[0].id, 'builder')
  assert.equal(options[1].id, ROOM_ASSISTANT_ID)
})

test('a finished participant drops out of the menu', () => {
  const options = recipientOptions(
    room([participant({ roleId: 'builder', state: 'done' }), participant({ roleId: 'reviewer' })])
  )
  assert.deepEqual(options.map((option) => option.id), ['reviewer', ROOM_ASSISTANT_ID, ROOM_EVERYONE])
})

test('the menu says what each participant is doing', () => {
  const options = recipientOptions(
    room([participant({ roleId: 'builder', state: 'working' }), participant({ roleId: 'planner', state: 'stale' })])
  )
  assert.equal(options[0].detail, 'working')
  assert.equal(options[1].detail, 'idle', 'a dropped session reads as idle, not as an error')
})

test('the chip shows the name the user chose', () => {
  const state = room([participant({ roleId: 'r1', label: 'Codey' })])
  assert.equal(recipientLabel(state, 'r1'), 'Codey')
  assert.equal(recipientLabel(state, ROOM_ASSISTANT_ID), 'BOSS')
})

test('an unknown recipient falls back to BOSS rather than showing nothing', () => {
  assert.equal(recipientLabel(room([]), 'ghost'), 'BOSS')
  assert.equal(recipientKind(room([]), 'ghost'), 'assistant')
})

test('BOSS and a broadcast look different from a worker', () => {
  const state = room([participant({ roleId: 'builder' })])
  assert.equal(recipientKind(state, 'builder'), 'participant')
  assert.equal(recipientKind(state, ROOM_ASSISTANT_ID), 'assistant')
  assert.equal(recipientKind(state, ROOM_EVERYONE), 'everyone')
})

test('typing a name retargets the chip and drops the name from the message', () => {
  const state = room([participant({ roleId: 'builder', label: 'Builder' })])
  assert.deepEqual(retarget(state, '@builder fix the header'), { recipient: 'builder', text: 'fix the header' })
  assert.deepEqual(retarget(state, '@Builder, fix it'), { recipient: 'builder', text: 'fix it' })
})

test('typing BOSS retargets from inside any room', () => {
  assert.deepEqual(retarget(room([]), '@boss what happened'), {
    recipient: ROOM_ASSISTANT_ID,
    text: 'what happened'
  })
})

test('an unrecognised name is left alone, because a wrong retarget is worse than none', () => {
  const state = room([participant({ roleId: 'builder' })])
  assert.deepEqual(retarget(state, '@ghost do something'), { text: '@ghost do something' })
})

test('a name inside a sentence does not retarget anything', () => {
  const state = room([participant({ roleId: 'builder', label: 'Builder' })])
  assert.deepEqual(retarget(state, 'tell @builder it is ready'), { text: 'tell @builder it is ready' })
})

test('a bare name with nothing after it still retargets', () => {
  const state = room([participant({ roleId: 'builder', label: 'Builder' })])
  assert.deepEqual(retarget(state, '@builder'), { recipient: 'builder', text: '' })
})

test('addressing someone who has finished is refused with a reason', () => {
  const state = room([participant({ roleId: 'builder', label: 'Builder', state: 'done' })])
  assert.match(String(recipientProblem(state, 'builder')), /has finished/)
})

test('a working participant, BOSS, and a broadcast are all sendable', () => {
  const state = room([participant({ roleId: 'builder', state: 'working' })])
  assert.equal(recipientProblem(state, 'builder'), undefined)
  assert.equal(recipientProblem(state, ROOM_ASSISTANT_ID), undefined)
  assert.equal(recipientProblem(state, ROOM_EVERYONE), undefined)
})

test('addressing a stale participant is allowed, because it starts a fresh one', () => {
  const state = room([participant({ roleId: 'planner', state: 'stale' })])
  assert.equal(recipientProblem(state, 'planner'), undefined)
})

test('a message can name a different agent without changing the team', () => {
  // A reviewer doing badly on one job should not mean editing the team and
  // remembering to put it back.
  assert.equal(overrideFor('reviewer', 'codex'), 'reviewer@codex')
  assert.deepEqual(splitOverride('reviewer@codex'), { roleId: 'reviewer', backendId: 'codex' })
})

test('an ordinary recipient has no agent attached', () => {
  assert.deepEqual(splitOverride('reviewer'), { roleId: 'reviewer' })
  assert.deepEqual(splitOverride('boss'), { roleId: 'boss' })
})

test('the chip names the agent only when it is not the usual one', () => {
  const state = room([participant({ roleId: 'reviewer', label: 'Reviewer' })])
  assert.equal(recipientLabel(state, 'reviewer'), 'Reviewer', 'an ordinary message stays one word')
  assert.equal(recipientLabel(state, 'reviewer@codex'), 'Reviewer · codex')
})

test('a one-off agent does not change what kind of recipient it is', () => {
  const state = room([participant({ roleId: 'reviewer' })])
  assert.equal(recipientKind(state, 'reviewer@codex'), 'participant')
})
