import React, { useEffect, useState } from 'react'
import type { BackendId } from '@shared/backend'
import { EMPTY_TASK_POLICY, type FallbackPolicy, type ReviewerPolicy, type TaskPolicy } from '@shared/task-policy'
import { appStore, useStore } from '../state/AppState'
import { BACKEND_SHORT_LABELS } from '../lib/backend-labels'
import { OpenCode } from '../lib/opencode'

function optionalNumber(value: string): number | undefined {
  const parsed = Number(value)
  return value.trim() && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

export function TaskPolicyModal(): React.JSX.Element | null {
  const target = useStore(appStore, (state) => state.policyTarget)
  const sessions = useStore(appStore, (state) => state.sessions)
  const backends = useStore(appStore, (state) => state.backends.filter((backend) => backend.available))
  const [policy, setPolicy] = useState<TaskPolicy>(EMPTY_TASK_POLICY)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const source = sessions.find((session) => session.id === target)

  useEffect(() => {
    if (!target) return
    setLoading(true)
    void OpenCode.taskPolicy(target).then((value) => setPolicy(value ?? EMPTY_TASK_POLICY)).finally(() => setLoading(false))
  }, [target])

  if (!target || !source) return null

  const setBudget = (key: keyof TaskPolicy['budget'], value: string): void => {
    setPolicy((current) => ({ ...current, budget: { ...current.budget, [key]: optionalNumber(value) } }))
  }
  const addReviewer = (): void => {
    const backendId = backends[0]?.id
    if (!backendId) return
    setPolicy((current) => ({ ...current, reviewers: [...current.reviewers, { backendId }] }))
  }
  const updateReviewer = (index: number, patch: Partial<ReviewerPolicy>): void => {
    setPolicy((current) => ({
      ...current,
      reviewers: current.reviewers.map((reviewer, position) => position === index ? { ...reviewer, ...patch } : reviewer)
    }))
  }
  const updateFallback = (patch: Partial<FallbackPolicy>): void => {
    const initial: FallbackPolicy = policy.fallback ?? { backendId: backends[0]?.id ?? 'opencode', trigger: 'error' }
    setPolicy((current) => ({ ...current, fallback: { ...initial, ...patch } }))
  }
  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await OpenCode.setTaskPolicy(target, policy)
      appStore.setState({ policyTarget: null })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal policy-modal">
        <div className="delegate-heading">
          <div>
            <span className="command-eyebrow">Task policy</span>
            <h3>{source.title || 'Untitled thread'}</h3>
          </div>
          <button className="btn-deny" onClick={() => appStore.setState({ policyTarget: null })}>Cancel</button>
        </div>
        {loading ? <div className="command-empty">Loading…</div> : (
          <>
            <label className="delegate-field">
              <span>Goal</span>
              <textarea rows={3} value={policy.goal} onChange={(event) => setPolicy((current) => ({ ...current, goal: event.target.value }))} placeholder="What does done look like?" />
            </label>
            <fieldset className="delegate-fieldset">
              <legend>Hard budget</legend>
              <div className="policy-budget-grid">
                <label><span>Runs</span><input type="number" min="1" value={policy.budget.maxRuns ?? ''} onChange={(event) => setBudget('maxRuns', event.target.value)} placeholder="Unlimited" /></label>
                <label><span>Reported tokens</span><input type="number" min="1" value={policy.budget.maxTokens ?? ''} onChange={(event) => setBudget('maxTokens', event.target.value)} placeholder="Unlimited" /></label>
                <label><span>Agent minutes</span><input type="number" min="0.1" step="0.1" value={policy.budget.maxDurationMinutes ?? ''} onChange={(event) => setBudget('maxDurationMinutes', event.target.value)} placeholder="Unlimited" /></label>
              </div>
              <small className="policy-note">When any limit is reached, R.A.L.F. blocks the next run until you raise or remove it.</small>
            </fieldset>
            <fieldset className="delegate-fieldset">
              <div className="policy-section-title"><legend>Reviewer chain</legend><button className="btn-ghost" onClick={addReviewer}>Add reviewer</button></div>
              {policy.reviewers.map((reviewer, index) => (
                <div className="policy-reviewer" key={`${index}-${reviewer.backendId}`}>
                  <span className="policy-order">{index + 1}</span>
                  <select value={reviewer.backendId} onChange={(event) => updateReviewer(index, { backendId: event.target.value as BackendId })}>
                    {backends.map((backend) => <option value={backend.id} key={backend.id}>{BACKEND_SHORT_LABELS[backend.id]}</option>)}
                  </select>
                  <input value={reviewer.instruction ?? ''} onChange={(event) => updateReviewer(index, { instruction: event.target.value })} placeholder="Review focus (optional)" />
                  <button className="btn-ghost" onClick={() => setPolicy((current) => ({ ...current, reviewers: current.reviewers.filter((_, position) => position !== index) }))}>Remove</button>
                </div>
              ))}
              {!policy.reviewers.length ? <small className="policy-note">No reviewers configured.</small> : null}
            </fieldset>
            <fieldset className="delegate-fieldset">
              <div className="policy-section-title"><legend>Fallback</legend><label className="policy-toggle"><input type="checkbox" checked={Boolean(policy.fallback)} onChange={(event) => setPolicy((current) => ({ ...current, fallback: event.target.checked ? { backendId: backends[0]?.id ?? 'opencode', trigger: 'error' } : undefined }))} /> Enabled</label></div>
              {policy.fallback ? <div className="policy-reviewer fallback">
                <select value={policy.fallback.backendId} onChange={(event) => updateFallback({ backendId: event.target.value as BackendId })}>{backends.map((backend) => <option value={backend.id} key={backend.id}>{BACKEND_SHORT_LABELS[backend.id]}</option>)}</select>
                <select value={policy.fallback.trigger} onChange={(event) => updateFallback({ trigger: event.target.value as FallbackPolicy['trigger'] })}><option value="error">On error</option><option value="interrupted">On interruption</option><option value="either">On either</option></select>
              </div> : null}
              <small className="policy-note">Reviewer and fallback execution will require explicit automation enablement; saving this policy does not launch agents.</small>
            </fieldset>
          </>
        )}
        <div className="actions"><button className="btn-allow" disabled={loading || saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save policy'}</button></div>
      </div>
    </div>
  )
}
