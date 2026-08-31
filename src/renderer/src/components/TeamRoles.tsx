import React from 'react'
import type { BackendId } from '@shared/backend'
import type { RoomRole } from '@shared/room'
import { BACKEND_SHORT_LABELS } from '../lib/backend-labels'
import { REACH_CHOICES } from '../lib/team-roles'
import { ROOM_ASSISTANT_ID } from '@shared/room'

/** The team, editable.
 *
 *  Rendered by both the one-time setup and the settings page. Two copies of
 *  these rows would drift, and the wording is the part that matters: it is the
 *  only place the user is told what an agent is allowed to do. */
export function TeamRoles({
  roles,
  available,
  onChange
}: {
  roles: RoomRole[]
  available: BackendId[]
  /** `typing` is true while the user is still mid-edit in a text field, so a
   *  caller that saves can wait for it to settle rather than writing per
   *  keystroke. */
  onChange: (roles: RoomRole[], typing?: boolean) => void
}): React.JSX.Element {
  const update = (id: string, patch: Partial<RoomRole>, typing = false): void =>
    onChange(roles.map((role) => (role.id === id ? { ...role, ...patch } : role)), typing)

  return (
    <div className="team-setup-rows">
      {roles.map((role) => (
        <div className="team-setup-row" key={role.id}>
          {/* BOSS's name is the app's name. Renaming it here left the user
              talking to one name and the agent answering to another. */}
          {role.id === ROOM_ASSISTANT_ID ? (
            <span className="role-name role-name-fixed">{role.label}</span>
          ) : (
            <input
              className="role-name"
              value={role.label}
              aria-label={`Name for the ${role.id} role`}
              onChange={(event) => update(role.id, { label: event.target.value }, true)}
            />
          )}
          <select
            className="role-agent"
            value={role.backendId}
            aria-label={`Agent for ${role.label}`}
            onChange={(event) => update(role.id, { backendId: event.target.value as BackendId })}
          >
            {available.map((id) => (
              <option key={id} value={id}>{BACKEND_SHORT_LABELS[id]}</option>
            ))}
          </select>
          {/* BOSS has no reach to set. It never changes code: it starts a room
              and the agents in that room do the work, each under its own
              setting. Offering the control here asked the user to decide
              something that changes nothing. */}
          {role.id === ROOM_ASSISTANT_ID ? null : (
            <select
              className="role-reach"
              value={role.mode ?? 'plan'}
              aria-label={`What ${role.label} may touch`}
              onChange={(event) => update(role.id, { mode: event.target.value as RoomRole['mode'] })}
            >
              {REACH_CHOICES.map((choice) => (
                <option key={choice.mode} value={choice.mode}>{choice.label}</option>
              ))}
            </select>
          )}
          {/* BOSS cannot be removed. It is who the user talks to, and every
              room needs it; a team without one would have nobody to ask. */}
          {role.id === ROOM_ASSISTANT_ID ? (
            <span className="role-fixed" title="BOSS is always on your team">always</span>
          ) : (
            <button
              className="role-remove"
              aria-label={`Remove ${role.label}`}
              title="Remove this role"
              onClick={() => onChange(roles.filter((entry) => entry.id !== role.id))}
            >
              ×
            </button>
          )}
        </div>
      ))}
      {roles.length === 0 ? (
        <div className="team-setup-row">
          <span className="reach">No roles. BOSS cannot start work without at least one.</span>
        </div>
      ) : null}
    </div>
  )
}
