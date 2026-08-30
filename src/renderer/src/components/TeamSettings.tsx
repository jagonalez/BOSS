import React, { useEffect, useRef, useState } from 'react'
import type { RoomRole, RoomShape, RoomTeam } from '@shared/room'
import { appStore, useStore } from '../state/AppState'
import { OpenCode } from '../lib/opencode'
import { TeamRoles } from './TeamRoles'
import { missingRoles } from '../lib/team-roles'

const SHAPE_CHOICES: Array<{ shape: RoomShape | 'ask'; label: string; detail: string }> = [
  { shape: 'ask', label: 'Ask me each time', detail: 'recommended' },
  { shape: 'direct', label: 'Just do it', detail: 'one agent, no review' },
  { shape: 'reviewed', label: 'Build and review', detail: 'a fresh agent checks the work' },
  { shape: 'full', label: 'Research, plan, build, review', detail: 'the full run' }
]

/** The team, after setup.
 *
 *  Setup runs once and then never appears again, so without this a user who
 *  deleted a role, or wanted a different agent reviewing, was stuck with what
 *  they chose on the first launch. Saves as you change it: a Save button on a
 *  settings page is a thing to forget to press. */
export function TeamSettings(): React.JSX.Element {
  const backends = useStore(appStore, (state) => state.backends)
  const available = backends.filter((backend) => backend.available).map((backend) => backend.id)
  const [team, setTeam] = useState<RoomTeam | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    void OpenCode.team()
      .then((current) => setTeam(current ?? null))
      .catch(() => setTeam(null))
      .finally(() => setLoading(false))
  }, [])

  // Every write replaces the whole file on disk. A change made by clicking
  // happens once, so it saves at once; a name typed letter by letter would
  // otherwise write ten times for one edit, and two of those could land out of
  // order. Waiting for typing to stop costs nothing the user can feel.
  const pending = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(pending.current), [])

  const write = (next: RoomTeam, settle = false): void => {
    setTeam(next)
    window.clearTimeout(pending.current)
    const save = (): void => {
      void OpenCode.setTeam(next).catch(() => {
        /* The screen already shows the change. Refusing it would be worse than a
         * write that has to be made again. */
      })
    }
    if (settle) pending.current = window.setTimeout(save, 400)
    else save()
  }

  if (loading) return <div className="settings-note">Loading…</div>

  if (!team) {
    return (
      <div className="settings-section">
        <h2>Your team</h2>
        <p className="settings-note">
          No team yet. BOSS asks for one the first time you use it, and the roles you choose there appear here.
        </p>
      </div>
    )
  }

  const canAdd = missingRoles(team.roles, available)

  return (
    <div className="settings-section">
      <h2>Your team</h2>
      <p className="settings-note">
        Who BOSS brings into a job, and what each may touch. Set once; every job uses them.
      </p>

      <TeamRoles
        roles={team.roles}
        available={available}
        onChange={(roles: RoomRole[], typing) => write({ ...team, roles }, typing)}
      />

      {canAdd.length > 0 ? (
        <div className="team-add">
          <span>Add a role</span>
          {canAdd.map((role) => (
            <button key={role.id} onClick={() => write({ ...team, roles: [...team.roles, role] })}>
              {role.label}
            </button>
          ))}
        </div>
      ) : null}

      <h2 className="team-settings-heading">How work runs</h2>
      <p className="settings-note">You choose the shape of every job. BOSS never picks it for you.</p>
      <div className="team-setup-rows">
        {SHAPE_CHOICES.map((choice) => {
          const chosen = choice.shape === 'ask' ? team.askShape : !team.askShape && team.defaultShape === choice.shape
          return (
            <button
              className={`team-setup-row choice ${chosen ? 'on' : ''}`}
              key={choice.shape}
              onClick={() =>
                write(
                  choice.shape === 'ask'
                    ? { ...team, askShape: true }
                    : { ...team, askShape: false, defaultShape: choice.shape }
                )
              }
            >
              <span className={`radio ${chosen ? 'on' : ''}`} />
              <span className="name">{choice.label}</span>
              <span className="reach">{choice.detail}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
