import React, { useEffect, useMemo, useState } from 'react'
import type { BackendId, DelegatePlacement } from '@shared/backend'
import { FAN_OUT_MAX_WORKERS, type FanOutWorker } from '@shared/fan-out'
import { appStore, useStore } from '../state/AppState'
import { delegateThread, fanOutThread } from '../lib/actions'
import { BACKEND_SHORT_LABELS } from '../lib/backend-labels'
import { BackendBadge } from './BackendControls'

export function DelegateModal(): React.JSX.Element | null {
  const target = useStore(appStore, (state) => state.delegateTarget)
  const sessions = useStore(appStore, (state) => state.sessions)
  const backends = useStore(appStore, (state) => state.backends)
  const source = useMemo(() => sessions.find((session) => session.id === target), [sessions, target])
  const [instruction, setInstruction] = useState('')
  const [backendId, setBackendId] = useState<BackendId>('opencode')
  const [placement, setPlacement] = useState<DelegatePlacement>('same-checkout')
  const [submitting, setSubmitting] = useState(false)
  // Which backend runs each competing attempt. One entry means an ordinary
  // delegate; two or more turns this into a fan-out.
  const [attempts, setAttempts] = useState<BackendId[]>([])

  useEffect(() => {
    if (!target) return
    setInstruction('')
    setBackendId(source?.backendId ?? backends.find((backend) => backend.available)?.id ?? 'opencode')
    setPlacement('same-checkout')
    setAttempts([])
    setSubmitting(false)
  }, [target, source?.backendId, backends])

  if (!target || !source) return null
  const global = source.projectId === 'global' || !source.projectPath
  const available = backends.filter((backend) => backend.available)

  const submit = async (): Promise<void> => {
    if (!instruction.trim() || submitting) return
    setSubmitting(true)
    if (attempts.length) {
      // The chosen backend is the first attempt, so the picker above still
      // means what it says when extra attempts are added beside it.
      const workers: FanOutWorker[] = [backendId, ...attempts].map((id) => ({ backendId: id }))
      const started = await fanOutThread(target, instruction.trim(), workers)
      if (started) appStore.setState({ delegateTarget: null })
      else setSubmitting(false)
      return
    }
    const created = await delegateThread(target, backendId, instruction.trim(), placement)
    if (created) appStore.setState({ delegateTarget: null })
    else setSubmitting(false)
  }

  return (
    <div className="modal-backdrop">
      <div className="modal delegate-modal">
        <div className="delegate-heading">
          <div>
            <span className="command-eyebrow">{attempts.length ? `${attempts.length + 1} competing attempts` : 'New local worker'}</span>
            <h3>Delegate from “{source.title || 'Untitled thread'}”</h3>
          </div>
          <button className="btn-deny" onClick={() => appStore.setState({ delegateTarget: null })}>Cancel</button>
        </div>
        <label className="delegate-field">
          <span>Task</span>
          <textarea
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            placeholder="What should the worker accomplish?"
            autoFocus
            rows={5}
          />
          <small>BOSS includes a bounded transcript and changed-file summary automatically.</small>
        </label>
        <fieldset className="delegate-fieldset">
          <legend>Backend</legend>
          <div className="delegate-backends">
            {available.map((backend) => (
              <button
                key={backend.id}
                type="button"
                className={backend.id === backendId ? 'selected' : ''}
                onClick={() => setBackendId(backend.id)}
              >
                <BackendBadge backendId={backend.id} />
                <span><strong>{BACKEND_SHORT_LABELS[backend.id]}</strong><small>{backend.description}</small></span>
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset className="delegate-fieldset">
          <div className="policy-section-title">
            <legend>Competing attempts</legend>
            <button
              className="btn-ghost"
              type="button"
              disabled={global || attempts.length + 1 >= FAN_OUT_MAX_WORKERS || available.length === 0}
              onClick={() => setAttempts((current) => [...current, available[0]?.id ?? backendId])}
            >
              Add attempt
            </button>
          </div>
          {attempts.length ? (
            <>
              {[backendId, ...attempts].map((id, index) => (
                <div className="policy-reviewer" key={`${index}-${id}`}>
                  <span className="policy-order">{index + 1}</span>
                  {index === 0 ? (
                    <span className="delegate-attempt-fixed">{BACKEND_SHORT_LABELS[id]} (chosen above)</span>
                  ) : (
                    <select
                      value={id}
                      onChange={(event) => setAttempts((current) =>
                        current.map((entry, position) => position === index - 1 ? event.target.value as BackendId : entry))}
                    >
                      {available.map((backend) => (
                        <option value={backend.id} key={backend.id}>{BACKEND_SHORT_LABELS[backend.id]}</option>
                      ))}
                    </select>
                  )}
                  {index > 0 ? (
                    <button
                      className="btn-ghost"
                      type="button"
                      onClick={() => setAttempts((current) => current.filter((_, position) => position !== index - 1))}
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
              ))}
              <small className="policy-note">
                Each attempt solves the same task in its own Git worktree, so their diffs can be compared afterwards.
              </small>
            </>
          ) : (
            <small className="policy-note">
              {global
                ? 'Projectless chats cannot fan out, because each attempt needs its own worktree.'
                : 'Add an attempt to run this task several ways at once and compare the results.'}
            </small>
          )}
        </fieldset>
        <fieldset className="delegate-fieldset">
          <legend>Working directory</legend>
          {attempts.length ? (
            <small className="policy-note">
              Every attempt gets its own new Git worktree. Sharing a checkout would let them overwrite each other.
            </small>
          ) : null}
          <label className={`delegate-choice ${attempts.length ? 'disabled' : ''}`}>
            <input type="radio" disabled={attempts.length > 0} checked={!attempts.length && placement === 'same-checkout'} onChange={() => setPlacement('same-checkout')} />
            <span><strong>Current checkout</strong><small>Use the source thread’s current project or worktree.</small></span>
          </label>
          <label className={`delegate-choice ${global && !attempts.length ? 'disabled' : ''}`}>
            <input type="radio" disabled={global || attempts.length > 0} checked={attempts.length > 0 || placement === 'new-worktree'} onChange={() => setPlacement('new-worktree')} />
            <span><strong>New Git worktree</strong><small>Give the worker an isolated branch and folder.</small></span>
          </label>
        </fieldset>
        <div className="actions">
          <button className="btn-allow" disabled={!instruction.trim() || submitting || available.length === 0} onClick={() => void submit()}>
            {submitting
              ? 'Starting…'
              : attempts.length
                ? `Start ${attempts.length + 1} attempts`
                : 'Start delegate'}
          </button>
        </div>
      </div>
    </div>
  )
}
