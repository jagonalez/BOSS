import React, { useEffect, useRef, useState } from 'react'
import type { Presence } from '@shared/notification'
import { PRESENCES, PRESENCE_LABELS } from '@shared/notification'
import { OpenCode } from '../lib/opencode'

/** Where the user is, shown and set.
 *
 *  Three modes, and the user picks. Only an agent could set this before, told
 *  by the user in words — so a setting that decided whether their phone stayed
 *  silent was invisible in the app and unreachable without asking for it.
 *
 *  Held here rather than in the app store because nothing else needs it, and it
 *  changes about as often as a person leaves their desk. */
export function PresencePicker(): React.JSX.Element {
  const [presence, setPresence] = useState<Presence>('desk')
  const [open, setOpen] = useState(false)
  // What was withheld while the bar was higher, shown once on return. Coming
  // back must not mean finding out by accident that something needed an answer
  // two hours ago.
  const [waiting, setWaiting] = useState<Array<{ title: string; body: string }>>([])
  const anchor = useRef<HTMLDivElement>(null)

  // Read on mount, and again whenever the user comes back to the window or
  // opens the menu. An agent can change this too — the user says "heading out"
  // and BOSS sets it — and there is no event for that, so a pill read once
  // would sit there saying "At my desk" while the phone was the only thing
  // being told anything. Both moments are exactly when the answer is looked at.
  useEffect(() => {
    const read = (): void => {
      void OpenCode.presence().then(setPresence).catch(() => {
        /* Left as it was. A picker that cannot read the current mode must not
         * imply silence. */
      })
    }
    read()
    window.addEventListener('focus', read)
    return () => window.removeEventListener('focus', read)
  }, [])

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (!anchor.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const choose = (next: Presence): void => {
    setOpen(false)
    setPresence(next)
    void OpenCode.setPresence(next)
      .then((result) => setWaiting(result.waiting))
      .catch(() => {
        // The pill must not claim a mode that was never set. Showing "do not
        // disturb" over a machine that is still notifying is the one mistake
        // this control cannot make.
        setWaiting([])
        void OpenCode.presence().then(setPresence).catch(() => {})
      })
  }

  const current = PRESENCE_LABELS[presence]
  return (
    <div className="presence" ref={anchor}>
      <button
        className={`presence-pill ${presence}`}
        onClick={() => {
          // Re-read as it opens, so the menu never shows a mode that changed
          // under it.
          if (!open) void OpenCode.presence().then(setPresence).catch(() => {})
          setOpen((value) => !value)
        }}
        title={current.detail}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="presence-dot" />
        <span>{current.label}</span>
      </button>
      {open ? (
        <div className="presence-menu" role="menu">
          {PRESENCES.map((option) => (
            <button
              key={option}
              role="menuitemradio"
              aria-checked={option === presence}
              className={option === presence ? 'on' : ''}
              onClick={() => choose(option)}
            >
              <span className="presence-name">{PRESENCE_LABELS[option].label}</span>
              <span className="presence-detail">{PRESENCE_LABELS[option].detail}</span>
            </button>
          ))}
        </div>
      ) : null}
      {waiting.length > 0 ? (
        <div className="presence-waited" role="status">
          <span>{waiting.length === 1 ? 'One thing waited' : `${waiting.length} things waited`}</span>
          <button onClick={() => setWaiting([])}>Dismiss</button>
        </div>
      ) : null}
    </div>
  )
}
