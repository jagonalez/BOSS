import React, { useEffect, useMemo, useState } from 'react'
import type { BackendId, DelegatePlacement } from '@shared/backend'
import { appStore, useStore } from '../state/AppState'
import { delegateThread } from '../lib/actions'
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

  useEffect(() => {
    if (!target) return
    setInstruction('')
    setBackendId(source?.backendId ?? backends.find((backend) => backend.available)?.id ?? 'opencode')
    setPlacement('same-checkout')
    setSubmitting(false)
  }, [target, source?.backendId, backends])

  if (!target || !source) return null
  const global = source.projectId === 'global' || !source.projectPath
  const available = backends.filter((backend) => backend.available)

  const submit = async (): Promise<void> => {
    if (!instruction.trim() || submitting) return
    setSubmitting(true)
    const created = await delegateThread(target, backendId, instruction.trim(), placement)
    if (created) appStore.setState({ delegateTarget: null })
    else setSubmitting(false)
  }

  return (
    <div className="modal-backdrop">
      <div className="modal delegate-modal">
        <div className="delegate-heading">
          <div>
            <span className="command-eyebrow">New local worker</span>
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
          <small>R.A.L.F. includes a bounded transcript and changed-file summary automatically.</small>
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
          <legend>Working directory</legend>
          <label className="delegate-choice">
            <input type="radio" checked={placement === 'same-checkout'} onChange={() => setPlacement('same-checkout')} />
            <span><strong>Current checkout</strong><small>Use the source thread’s current project or worktree.</small></span>
          </label>
          <label className={`delegate-choice ${global ? 'disabled' : ''}`}>
            <input type="radio" disabled={global} checked={placement === 'new-worktree'} onChange={() => setPlacement('new-worktree')} />
            <span><strong>New Git worktree</strong><small>Give the worker an isolated branch and folder.</small></span>
          </label>
        </fieldset>
        <div className="actions">
          <button className="btn-allow" disabled={!instruction.trim() || submitting || available.length === 0} onClick={() => void submit()}>
            {submitting ? 'Starting…' : 'Start delegate'}
          </button>
        </div>
      </div>
    </div>
  )
}
