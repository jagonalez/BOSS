import type { BackendId } from '../../../shared/backend'
import type { RoomRole } from '../../../shared/room'

/** What a role may touch, said in plain words.
 *
 *  Deliberately never the name of a permission mode. The user answers "when
 *  should it stop and ask", not "which policy applies". */
export function reachOf(role: RoomRole): string {
  if (role.mode === 'auto') return 'its own copy of the code'
  if (role.mode === 'ask') return 'asks before shipping'
  return 'reads only'
}

/** What a role may touch, as the user chooses it. Three answers, no modes. */
export const REACH_CHOICES: Array<{ mode: RoomRole['mode']; label: string }> = [
  { mode: 'plan', label: 'reads only' },
  { mode: 'auto', label: 'its own copy of the code' },
  { mode: 'ask', label: 'asks before shipping' }
]

/** A role the user can add back, once they have deleted one.
 *
 *  Only the defaults BOSS knows how to place in a run. A role of an invented
 *  name would never be reached, because what a shape means is defined in terms
 *  of these. */
export const ADDABLE_ROLES: RoomRole[] = [
  // BOSS is not here: it cannot be removed, so it can never need adding back.
  { id: 'researcher', label: 'Researcher', backendId: 'claude', mode: 'plan' },
  { id: 'planner', label: 'Planner', backendId: 'claude', mode: 'plan' },
  { id: 'builder', label: 'Builder', backendId: 'codex', mode: 'auto' },
  { id: 'reviewer', label: 'Reviewer', backendId: 'claude', mode: 'plan' },
  { id: 'releaser', label: 'Releaser', backendId: 'codex', mode: 'ask' }
]

export function missingRoles(roles: RoomRole[], available: BackendId[]): RoomRole[] {
  if (available.length === 0) return []
  const have = new Set(roles.map((role) => role.id))
  return ADDABLE_ROLES.filter((role) => !have.has(role.id)).map((role) => ({
    ...role,
    // A default names an agent the user may not have connected. Fall back to one
    // they do have, rather than offering a role that cannot run.
    backendId: available.includes(role.backendId) ? role.backendId : available[0]
  }))
}
