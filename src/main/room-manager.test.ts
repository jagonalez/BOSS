import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
// @ts-expect-error Node's type-stripping test runner needs the extension.
import { RoomManager, rolesForShape, suggestedRoles, type RoomHost } from './room-manager.ts'
// @ts-expect-error Node's type-stripping test runner needs the extension.
import { PARTICIPANT_STALE_AFTER_MS } from '../shared/room.ts'
import type { RoomTeam } from '../shared/room'

const TEAM: RoomTeam = {
  version: 1,
  askShape: true,
  defaultShape: 'reviewed',
  roles: [
    { id: 'researcher', label: 'Researcher', backendId: 'claude', mode: 'plan' },
    { id: 'planner', label: 'Planner', backendId: 'claude', mode: 'plan' },
    { id: 'builder', label: 'Builder', backendId: 'codex', mode: 'auto' },
    { id: 'reviewer', label: 'Reviewer', backendId: 'claude', mode: 'plan' }
  ]
}

interface Harness {
  manager: RoomManager
  stateFile: string
  host: RoomHost
  created: string[]
  disposed: string[]
  now: () => number
  setNow: (value: number) => void
  cleanup: () => Promise<void>
}

async function harness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'boss-room-'))
  const created: string[] = []
  const disposed: string[] = []
  let clock = 1_000
  const host: RoomHost = {
    async createParticipantThread({ roleId }) {
      const id = `thread-${roleId}-${created.length}`
      created.push(id)
      return id
    },
    async disposeParticipantThread(threadId) {
      disposed.push(threadId)
    },
    roomPaths() {
      return { projectPath: '/hyper', executionPath: '/hyper' }
    }
  }
  const stateFile = join(dir, 'rooms.json')
  const manager = new RoomManager(stateFile, host, () => clock)
  return {
    manager,
    // Exposed so a test can open a second manager on the same file, which is
    // what reopening the app does.
    stateFile,
    host,
    created,
    disposed,
    now: () => clock,
    setNow: (value) => {
      clock = value
    },
    cleanup: () => rm(dir, { recursive: true, force: true })
  }
}

test('a room with no team cannot admit a participant', async () => {
  const h = await harness()
  const joined = await h.manager.join('room-1', 'builder')
  assert.equal(joined, undefined, 'roles only exist once the user has configured a team')
  assert.deepEqual(h.created, [], 'no hidden session is started')
  await h.cleanup()
})

test('a participant joins with its own hidden thread on its own backend', async () => {
  const h = await harness()
  await h.manager.configureTeam(TEAM)
  const joined = await h.manager.join('room-1', 'builder')
  assert.equal(joined?.roleId, 'builder')
  assert.equal(joined?.backendId, 'codex', 'the builder runs on the backend the user chose for it')
  assert.equal(h.created.length, 1, 'exactly one session per participant')
  await h.cleanup()
})

test('a reviewer can run on a different backend from the builder in one room', async () => {
  const h = await harness()
  await h.manager.configureTeam(TEAM)
  await h.manager.join('room-1', 'builder')
  await h.manager.join('room-1', 'reviewer')
  const room = await h.manager.room('room-1')
  const builder = room.participants.find((entry) => entry.roleId === 'builder')
  const reviewer = room.participants.find((entry) => entry.roleId === 'reviewer')
  assert.equal(builder?.backendId, 'codex')
  assert.equal(reviewer?.backendId, 'claude', 'a second opinion from the same model is not a second opinion')
  await h.cleanup()
})

test('joining twice reuses the session, so a repeated mention cannot spawn a second one', async () => {
  const h = await harness()
  await h.manager.configureTeam(TEAM)
  const first = await h.manager.join('room-1', 'builder')
  const second = await h.manager.join('room-1', 'builder')
  assert.equal(second?.threadId, first?.threadId)
  assert.equal(h.created.length, 1)
  await h.cleanup()
})

test('the recipient stays where the user left it', async () => {
  const h = await harness()
  await h.manager.setRecipient('room-1', 'builder')
  assert.equal((await h.manager.room('room-1')).recipient, 'builder')
  await h.cleanup()
})

test('an idle participant is retired, and its session is dropped rather than resumed', async () => {
  const h = await harness()
  await h.manager.configureTeam(TEAM)
  const joined = await h.manager.join('room-1', 'planner')
  h.setNow(h.now() + PARTICIPANT_STALE_AFTER_MS + 1)

  const retired = await h.manager.retireStale('room-1')
  assert.deepEqual(retired, ['planner'])
  assert.deepEqual(h.disposed, [joined?.threadId], 'the old context is never resent')

  const room = await h.manager.room('room-1')
  const planner = room.participants.find((entry) => entry.roleId === 'planner')
  assert.equal(planner?.state, 'stale')
  assert.equal(planner?.threadId, undefined, 'addressing it later starts a fresh one')
  await h.cleanup()
})

test('a participant in use does not go stale', async () => {
  const h = await harness()
  await h.manager.configureTeam(TEAM)
  await h.manager.join('room-1', 'builder')
  h.setNow(h.now() + PARTICIPANT_STALE_AFTER_MS - 1)
  await h.manager.touch('room-1', 'builder')
  h.setNow(h.now() + PARTICIPANT_STALE_AFTER_MS - 1)

  assert.deepEqual(await h.manager.retireStale('room-1'), [], 'speaking keeps it alive')
  await h.cleanup()
})

test('retiring twice does not dispose the same session twice', async () => {
  const h = await harness()
  await h.manager.configureTeam(TEAM)
  await h.manager.join('room-1', 'planner')
  h.setNow(h.now() + PARTICIPANT_STALE_AFTER_MS + 1)

  await h.manager.retireStale('room-1')
  assert.deepEqual(await h.manager.retireStale('room-1'), [], 'a stale participant is already retired')
  assert.equal(h.disposed.length, 1)
  await h.cleanup()
})

test('job notes survive a restart, because they are what carries a job forward', async () => {
  const h = await harness()
  await h.manager.recordNotes('room-1', {
    agreed: ['save the query and the sort order'],
    decided: [{ text: 'the index stays in the existing layer', at: 5, by: 'builder' }]
  })
  const room = await h.manager.room('room-1')
  assert.deepEqual(room.notes.agreed, ['save the query and the sort order'])
  assert.equal(room.notes.updatedAt, h.now(), 'notes record when they last changed')
  await h.cleanup()
})

test('recording one field of the notes leaves the others alone', async () => {
  const h = await harness()
  await h.manager.recordNotes('room-1', { agreed: ['no cap on saved searches'] })
  await h.manager.recordNotes('room-1', { changed: ['11 files, 3 new tests'] })
  const room = await h.manager.room('room-1')
  assert.deepEqual(room.notes.agreed, ['no cap on saved searches'], 'an earlier agreement is not lost')
  assert.deepEqual(room.notes.changed, ['11 files, 3 new tests'])
  await h.cleanup()
})

test('the brief a fresh participant reads holds the agreements, not a transcript', async () => {
  const h = await harness()
  const notes = await h.manager.recordNotes('room-1', {
    agreed: ['inline warning, never an empty list'],
    decided: [{ text: 'index stays in the existing layer', at: 5, by: 'builder' }],
    changed: ['11 files']
  })
  const brief = h.manager.briefFor(notes)
  assert.match(brief, /AGREED/)
  assert.match(brief, /inline warning, never an empty list/)
  assert.match(brief, /index stays in the existing layer \(builder\)/)
  assert.match(brief, /CHANGED/)
  await h.cleanup()
})

test('an empty brief is empty rather than a heading with nothing under it', async () => {
  const h = await harness()
  assert.equal(h.manager.briefFor({ agreed: [], decided: [], changed: [], updatedAt: 0 }), '')
  await h.cleanup()
})

test('forgetting a room clears its state when the thread is gone', async () => {
  const h = await harness()
  await h.manager.configureTeam(TEAM)
  await h.manager.join('room-1', 'builder')
  await h.manager.forget('room-1')
  assert.deepEqual((await h.manager.room('room-1')).participants, [])
  await h.cleanup()
})

test('a suggested reviewer differs from the suggested builder when there is a choice', () => {
  const roles = suggestedRoles(['claude', 'codex'])
  const builder = roles.find((role) => role.id === 'builder')
  const reviewer = roles.find((role) => role.id === 'reviewer')
  assert.equal(builder?.backendId, 'codex')
  assert.notEqual(reviewer?.backendId, builder?.backendId, 'the reviewer must be a second opinion')
})

test('one connected agent still yields a usable team', () => {
  const roles = suggestedRoles(['claude'])
  assert.equal(roles.length, 5)
  assert.ok(
    roles.every((role) => role.backendId === 'claude'),
    'a single agent fills every role rather than blocking setup'
  )
})

test('no connected agents yields no roles', () => {
  assert.deepEqual(suggestedRoles([]), [])
})

test('a direct shape uses one participant, because a one-line fix needs no ceremony', () => {
  assert.deepEqual(rolesForShape('direct', TEAM), ['builder'])
})

test('a reviewed shape builds then reviews', () => {
  assert.deepEqual(rolesForShape('reviewed', TEAM), ['builder', 'reviewer'])
})

test('a full shape researches, plans, builds and reviews', () => {
  assert.deepEqual(rolesForShape('full', TEAM), ['researcher', 'planner', 'builder', 'reviewer'])
})

test('a shape skips roles the user deleted from their team', () => {
  const lean: RoomTeam = { ...TEAM, roles: TEAM.roles.filter((role) => role.id !== 'reviewer') }
  assert.deepEqual(rolesForShape('reviewed', lean), ['builder'], 'deleting a role removes that step')
})

test('recording notes for one field leaves the rest of the job intact', async () => {
  // An agent records what it knows when it knows it. Replacing the whole set
  // each time would let a builder wipe what the planner agreed.
  const h = await harness()
  await h.manager.recordNotes('room-1', { agreed: ['inline warning, never an empty list'] })
  await h.manager.recordNotes('room-1', {
    decided: [{ text: 'index stays in the existing layer', at: 5, by: 'builder' }]
  })

  const room = await h.manager.room('room-1')
  assert.deepEqual(room.notes.agreed, ['inline warning, never an empty list'])
  assert.equal(room.notes.decided.length, 1)
  await h.cleanup()
})

test('a job that recorded nothing hands a fresh agent an empty brief, not a broken one', async () => {
  const h = await harness()
  const room = await h.manager.room('room-never-used')
  assert.equal(h.manager.briefFor(room.notes), '', 'nothing to say is said as nothing')
  await h.cleanup()
})

test('BOSS joins any room without being a configured role', async () => {
  // It is a participant in every room, not something the user sets up. One
  // session per room, reading that room.
  const h = await harness()
  await h.manager.configureTeam(TEAM)
  const joined = await h.manager.join('room-1', 'boss')
  assert.equal(joined?.roleId, 'boss')
  assert.equal(joined?.label, 'BOSS')
  await h.cleanup()
})

test('BOSS in two rooms gets a session each, so neither can cross the other', async () => {
  // One shared session meant two rooms raced: their replies crossed and the
  // first room was left permanently busy.
  const h = await harness()
  await h.manager.configureTeam(TEAM)
  const first = await h.manager.join('room-1', 'boss')
  const second = await h.manager.join('room-2', 'boss')
  assert.notEqual(first?.threadId, second?.threadId)
  await h.cleanup()
})

test('BOSS reads rather than writes, whatever the user named their roles', async () => {
  const h = await harness()
  await h.manager.configureTeam(TEAM)
  const joined = await h.manager.join('room-1', 'boss')
  assert.equal(joined?.backendId, 'claude', 'it takes the agent behind a reading role')
  await h.cleanup()
})

test('BOSS cannot join before the user has a team', async () => {
  const h = await harness()
  assert.equal(await h.manager.join('room-1', 'boss'), undefined)
  await h.cleanup()
})

test('a joining participant has read nothing, so its brief still reaches it', async () => {
  // Stamping the arrival time made a fresh reviewer look caught up, and the job
  // notes and the diff never reached it. A reviewer with no brief is exactly
  // the thing the user does not trust.
  const h = await harness()
  await h.manager.configureTeam(TEAM)
  const joined = await h.manager.join('room-1', 'reviewer')
  assert.equal(joined?.lastActiveAt, undefined, 'joining is not the same as having read the room')
})

test('speaking marks a participant as caught up', async () => {
  const h = await harness()
  await h.manager.configureTeam(TEAM)
  await h.manager.join('room-1', 'builder')
  await h.manager.touch('room-1', 'builder')

  const room = await h.manager.room('room-1')
  assert.equal(room.participants[0].lastActiveAt, h.now())
  await h.cleanup()
})

test('a job can be handed to a different agent without changing the team', async () => {
  // A reviewer doing badly on one job should not mean editing the team and
  // remembering to put it back.
  const h = await harness()
  await h.manager.configureTeam(TEAM)
  const usual = await h.manager.join('room-1', 'reviewer')
  assert.equal(usual?.backendId, 'claude')

  const handed = await h.manager.join('room-2', 'reviewer', 'codex')
  assert.equal(handed?.backendId, 'codex')
  await h.cleanup()
})

test('handing a job over leaves the team alone', async () => {
  const h = await harness()
  await h.manager.configureTeam(TEAM)
  await h.manager.join('room-1', 'reviewer', 'codex')

  const team = await h.manager.currentTeam()
  assert.equal(
    team?.roles.find((role) => role.id === 'reviewer')?.backendId,
    'claude',
    'the role keeps its own agent for every other job'
  )
  await h.cleanup()
})

test('two reads at once both wait for the file, so a saved team is never missed', async () => {
  // The flag was set before the read, not after. Two callers arriving together
  // both saw "not loaded", and the second returned while the file was still
  // being read — so the team looked missing and the one-time setup appeared in
  // front of a user who already had one.
  const h = await harness()
  await h.manager.configureTeam(TEAM)

  const reopened = new RoomManager(h.stateFile, h.host, () => h.now())
  const [first, second] = await Promise.all([reopened.currentTeam(), reopened.currentTeam()])

  assert.equal(first?.roles.length, TEAM.roles.length)
  assert.equal(second?.roles.length, TEAM.roles.length, 'the second caller must not race past the read')
  await h.cleanup()
})
