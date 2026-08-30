import React, { useEffect, useRef, useState } from 'react'
import type { BackendId } from '@shared/backend'
import type { RoomRole, RoomShape, RoomTeam } from '@shared/room'
import { appStore, useStore } from '../state/AppState'
import { OpenCode } from '../lib/opencode'
import { BACKEND_SHORT_LABELS } from '../lib/backend-labels'
import { TeamRoles } from './TeamRoles'

/** Roles BOSS proposes from the agents the user has already connected.
 *
 *  Mirrors what main suggests, so the screen can render before any round trip.
 *  These are defaults the user renames or deletes; nothing downstream may
 *  assume these ids exist. */
function suggested(available: BackendId[]): RoomRole[] {
  if (available.length === 0) return []
  const strongest = available.includes('claude') ? 'claude' : available[0]
  const builder = available.includes('codex') ? 'codex' : strongest
  // A second opinion from the same model is not a second opinion, so the
  // reviewer differs from the builder whenever there is a choice.
  const reviewer = available.find((id) => id !== builder) ?? builder
  return [
    // First, because it is who the user talks to. It coordinates and never
    // edits code, so it reads only.
    { id: 'boss', label: 'BOSS', backendId: strongest, mode: 'plan' },
    { id: 'researcher', label: 'Researcher', backendId: strongest, mode: 'plan' },
    { id: 'planner', label: 'Planner', backendId: strongest, mode: 'plan' },
    { id: 'builder', label: 'Builder', backendId: builder, mode: 'auto' },
    { id: 'reviewer', label: 'Reviewer', backendId: reviewer, mode: 'plan' },
    { id: 'releaser', label: 'Releaser', backendId: builder, mode: 'ask' }
  ]
}

const ASK_OPTIONS: Array<{ shape: RoomShape | 'ask'; label: string; detail: string }> = [
  { shape: 'ask', label: 'Ask me each time', detail: 'recommended' },
  { shape: 'direct', label: 'Just do it', detail: 'one agent, no review' },
  { shape: 'reviewed', label: 'Build and review', detail: 'a fresh agent checks the work' },
  { shape: 'full', label: 'Research, plan, build, review', detail: 'the full run' }
]

/** The one-time team setup.
 *
 *  Three screens, and the middle one is usually a single click. The user was
 *  explicit that setup burden is what stops people using a tool, so every
 *  screen arrives already answered. */
export function TeamSetup({ onDone }: { onDone: () => void }): React.JSX.Element {
  const backends = useStore(appStore, (state) => state.backends)
  const available = backends.filter((backend) => backend.available).map((backend) => backend.id)
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [roles, setRoles] = useState<RoomRole[]>([])
  const [askShape, setAskShape] = useState(true)
  const [defaultShape, setDefaultShape] = useState<RoomShape>('reviewed')
  const [saving, setSaving] = useState(false)

  // Filled once, from what is connected. Refilling whenever the list is empty
  // meant deleting the last role silently brought all five back and threw away
  // the four deletions before it.
  const filled = useRef(false)
  useEffect(() => {
    if (filled.current || available.length === 0) return
    filled.current = true
    setRoles(suggested(available))
  }, [available])

  const save = async (): Promise<void> => {
    setSaving(true)
    const team: RoomTeam = { version: 1, roles, askShape, defaultShape }
    await OpenCode.setTeam(team).catch(() => {
      /* A team that will not save must not trap the user on this screen. They
       * can set it again from settings, and BOSS still works without one. */
    })
    setSaving(false)
    onDone()
  }

  return (
    <div className="team-setup">
      <div className="team-setup-card">
        <div className="team-setup-steps">
          <i className={step >= 1 ? 'on' : ''} />
          <i className={step >= 2 ? 'on' : ''} />
          <i className={step >= 3 ? 'on' : ''} />
        </div>

        {step === 1 && (
          <>
            <h2>Which agents can BOSS use?</h2>
            <p className="team-setup-sub">These are the ones already installed on this machine.</p>
            <div className="team-setup-rows">
              {backends.map((backend) => (
                <div className="team-setup-row" key={backend.id}>
                  <span className="name">{BACKEND_SHORT_LABELS[backend.id]}</span>
                  <span className={`state ${backend.available ? '' : 'off'}`}>
                    {backend.available ? 'ready' : backend.unavailableReason ?? 'not connected'}
                  </span>
                </div>
              ))}
            </div>
            <div className="team-setup-actions">
              <button className="primary" onClick={() => setStep(2)} disabled={available.length === 0}>
                Continue
              </button>
            </div>
            {available.length === 0 ? (
              <p className="team-setup-note">Connect at least one agent before setting up a team.</p>
            ) : null}
          </>
        )}

        {step === 2 && (
          <>
            <h2>Your team</h2>
            <p className="team-setup-sub">BOSS filled this in from what you connected. Keep it, or change a row.</p>
            <TeamRoles roles={roles} available={available} onChange={setRoles} />
            <div className="team-setup-actions">
              <button onClick={() => setStep(1)}>Back</button>
              <button className="primary" onClick={() => setStep(3)} disabled={roles.length === 0}>
                Keep this team
              </button>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <h2>How should work run?</h2>
            <p className="team-setup-sub">You choose the shape of every job. BOSS never picks it for you.</p>
            <div className="team-setup-rows">
              {ASK_OPTIONS.map((option) => {
                const chosen = option.shape === 'ask' ? askShape : !askShape && defaultShape === option.shape
                return (
                  <button
                    className={`team-setup-row choice ${chosen ? 'on' : ''}`}
                    key={option.shape}
                    onClick={() => {
                      if (option.shape === 'ask') {
                        setAskShape(true)
                        return
                      }
                      setAskShape(false)
                      setDefaultShape(option.shape)
                    }}
                  >
                    <span className={`radio ${chosen ? 'on' : ''}`} />
                    <span className="name">{option.label}</span>
                    <span className="reach">{option.detail}</span>
                  </button>
                )
              })}
            </div>
            <div className="team-setup-actions">
              <button onClick={() => setStep(2)}>Back</button>
              <button className="primary" onClick={() => void save()} disabled={saving}>
                {saving ? 'Saving…' : 'Start'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
