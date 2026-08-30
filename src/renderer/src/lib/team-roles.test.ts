import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Application code uses bundler resolution.
import { missingRoles, reachOf } from './team-roles.ts'
import type { RoomRole } from '../../../shared/room.ts'

function role(overrides: Partial<RoomRole> = {}): RoomRole {
  return { id: 'builder', label: 'Builder', backendId: 'codex', mode: 'auto', ...overrides }
}

test('what a role may touch is said in plain words, never as a policy name', () => {
  // The user answers "when should it stop and ask", not "which mode applies".
  assert.equal(reachOf(role({ mode: 'auto' })), 'its own copy of the code')
  assert.equal(reachOf(role({ mode: 'ask' })), 'asks before shipping')
  assert.equal(reachOf(role({ mode: 'plan' })), 'reads only')
})

test('a role with no stated reach reads only, which is the safe answer', () => {
  assert.equal(reachOf(role({ mode: undefined })), 'reads only')
})

test('only roles the user has deleted are offered back', () => {
  const kept = [role({ id: 'builder' }), role({ id: 'reviewer' })]
  const offered = missingRoles(kept, ['claude', 'codex']).map((entry) => entry.id)
  assert.deepEqual(offered, ['researcher', 'planner', 'releaser'])
})

test('a full team offers nothing to add', () => {
  const full = ['researcher', 'planner', 'builder', 'reviewer', 'releaser'].map((id) => role({ id }))
  assert.deepEqual(missingRoles(full, ['claude']), [])
})

test('an offered role never names an agent the user has not connected', () => {
  // Its default names one they may not have. Offering a role that cannot run is
  // worse than offering it on the agent they do have.
  const offered = missingRoles([], ['opencode'])
  assert.ok(offered.length > 0)
  assert.ok(
    offered.every((entry) => entry.backendId === 'opencode'),
    'every offered role runs on something that exists'
  )
})

test('no connected agents means nothing to add', () => {
  assert.deepEqual(missingRoles([], []), [])
})
