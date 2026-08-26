import React, { useEffect, useMemo, useState } from 'react'
import { useStore, appStore } from '../state/AppState'
import type { JournalEntry, Workflow, WorkflowApprovalMode, WorkflowRun } from '@shared/workflow'
import { OpenCode } from '../lib/opencode'
import { authorWorkflowWithAgent, refreshWorkflows, selectSession } from '../lib/actions'
import { BranchIcon, ChatIcon, ChevronIcon, PlusIcon, SendIcon, StopIcon, TrashIcon } from './icons'

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return 'now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

function triggersLabel(workflow: Workflow): string {
  if (workflow.triggers.length === 0) return 'Manual only'
  return workflow.triggers
    .map((trigger) => (trigger.kind === 'cron' ? `Cron: ${trigger.expression}` : `On ${trigger.pattern.type}`))
    .join(' · ')
}

function isActiveRun(run: WorkflowRun): boolean {
  return run.status === 'running' || run.status === 'waiting'
}

function StepRow({ run, entry }: { run: WorkflowRun; entry: JournalEntry }): React.JSX.Element {
  const [answer, setAnswer] = useState('')
  const pendingAsk = entry.op === 'ask' && entry.status === 'started'
  const submit = async (): Promise<void> => {
    if (!answer.trim()) return
    try {
      await OpenCode.answerWorkflowRun(run.id, entry.seq, answer.trim())
      setAnswer('')
    } catch (error) {
      appStore.setState({ lastError: error instanceof Error ? error.message : String(error) })
    }
    await refreshWorkflows()
  }
  return (
    <div className={`workflow-step status-${entry.status}`}>
      <span className={`site-badge automation-badge status-${entry.status === 'done' ? 'success' : entry.status === 'failed' ? 'failure' : 'running'}`}>
        {entry.op}
      </span>
      <div className="automation-run-main">
        <span className="automation-run-summary">{entry.label || entry.op}</span>
        {entry.error ? <small>{entry.error}</small> : null}
        {pendingAsk ? (
          <div className="workflow-answer">
            <input
              value={answer}
              placeholder="Your answer…"
              onChange={(event) => setAnswer(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submit()
              }}
            />
            <button className="btn-ghost" onClick={() => void submit()}>
              <SendIcon size={13} /> Answer
            </button>
          </div>
        ) : null}
      </div>
      {entry.threadId ? (
        <button className="btn-ghost" onClick={() => selectSession(entry.threadId!, false)} title="Open this step's thread">
          <ChatIcon size={13} /> Thread
        </button>
      ) : null}
    </div>
  )
}

function RunCard({ run }: { run: WorkflowRun }): React.JSX.Element {
  const [expanded, setExpanded] = useState(isActiveRun(run))
  const summary =
    run.error ??
    (run.result !== undefined && run.result !== null ? JSON.stringify(run.result) : undefined) ??
    (run.status === 'waiting' ? 'Waiting on an event, timer, or answer.' : run.status === 'running' ? 'Working…' : 'No result.')
  return (
    <div className={`automation-run status-${run.status}`}>
      <span className={`site-badge automation-badge status-${run.status === 'completed' ? 'success' : run.status === 'failed' || run.status === 'needs-attention' ? 'failure' : run.status}`}>
        {run.status}
      </span>
      <div className="automation-run-main">
        <span className="automation-run-summary">{summary}</span>
        <small>
          {run.trigger} · started {timeAgo(run.startedAt)}
          {run.note ? ` · ${run.note}` : ''}
        </small>
        {expanded ? (
          <div className="workflow-steps">
            {run.journal.length > 0
              ? run.journal.map((entry) => <StepRow key={entry.seq} run={run} entry={entry} />)
              : <div className="command-empty">No steps journaled yet.</div>}
          </div>
        ) : null}
      </div>
      <button className="btn-ghost" onClick={() => setExpanded((value) => !value)}>
        <ChevronIcon size={13} /> {expanded ? 'Hide' : `Steps (${run.journal.length})`}
      </button>
      {isActiveRun(run) ? (
        <button
          className="btn-ghost"
          onClick={() => {
            void OpenCode.stopWorkflowRun(run.id)
              .catch((error) => appStore.setState({ lastError: error instanceof Error ? error.message : String(error) }))
              .then(() => refreshWorkflows())
          }}
        >
          <StopIcon size={13} /> Stop
        </button>
      ) : null}
    </div>
  )
}

/** The composer is a request to an agent, not a form: describing the job in a
 *  sentence opens a seeded conversation that authors, tests, and iterates on
 *  the workflow with the boss_workflow_* tools. Humans never write scripts. */
function DescribeComposer({ refine, onClose }: { refine?: { id: string; name: string }; onClose: () => void }): React.JSX.Element {
  const [description, setDescription] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const send = async (): Promise<void> => {
    if (!description.trim()) return
    setSending(true)
    setError(null)
    try {
      await authorWorkflowWithAgent({ description: description.trim(), ...(refine ? { refine } : {}) })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSending(false)
    }
  }
  return (
    <div className="automation-editor workflow-describe">
      <label className="settings-row automation-prompt-row">
        <span className="settings-row-label">{refine ? `Refine "${refine.name}"` : 'Describe it'}</span>
        <textarea
          className="settings-input automation-prompt"
          rows={4}
          aria-label={refine ? 'Workflow refinement request' : 'Workflow request'}
          value={description}
          placeholder={
            refine
              ? 'What should change? e.g. "Only page me for monitors tagged team:sre, batch the rest into a weekly digest."'
              : 'What should this workflow watch or do? e.g. "Every 20 minutes, check our Datadog monitors; judge real alerts vs flaky ones and only ping me for real ones."'
          }
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      {error ? <div className="automation-error">{error}</div> : null}
      <div className="automation-editor-actions">
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="site-publish-btn" disabled={sending || !description.trim()} onClick={() => void send()}>
          <SendIcon size={13} /> Hand to an agent
        </button>
      </div>
    </div>
  )
}

function WorkflowCard({
  workflow,
  runs,
  onRefine
}: {
  workflow: Workflow
  runs: WorkflowRun[]
  onRefine: () => void
}): React.JSX.Element {
  const projectPath = useStore(appStore, (s) => s.projectPath)
  const [expanded, setExpanded] = useState(false)
  const awaitingApproval = !workflow.enabled && workflow.source === 'agent'
  // Reviewing before enabling is the point of ask-mode, so the script opens
  // by itself exactly when a signature is being requested.
  const [scriptOpen, setScriptOpen] = useState(awaitingApproval)
  const active = runs.find(isActiveRun)
  const lastRun = runs[0]
  const sameProject = !workflow.projectPath || workflow.projectPath === projectPath

  const act = async (action: () => Promise<unknown>): Promise<void> => {
    try {
      await action()
    } catch (error) {
      appStore.setState({ lastError: error instanceof Error ? error.message : String(error) })
    }
    await refreshWorkflows()
  }

  return (
    <div className={`site-card automation-card${active ? ' running' : ''}${awaitingApproval ? ' workflow-awaiting' : ''}`}>
      <div className="site-card-head">
        <span className="command-state-icon"><BranchIcon size={14} /></span>
        <div className="command-session-main">
          <strong>{workflow.name}</strong>
          <small>{workflow.projectPath || 'Global'} · {triggersLabel(workflow)}</small>
          {workflow.description ? <small>{workflow.description}</small> : null}
        </div>
        {active ? <span className="site-badge automation-badge status-running">{active.status}</span> : null}
        {awaitingApproval ? (
          <span className="site-badge automation-badge status-failure" title="Triggers stay dormant until you approve this script.">
            Awaiting approval
          </span>
        ) : !workflow.enabled ? (
          <span className="site-badge">Disabled</span>
        ) : null}
        {workflow.source === 'agent' ? <span className="site-badge">Agent-authored</span> : null}
        <span className="site-time">{workflow.lastRunAt ? `Ran ${timeAgo(workflow.lastRunAt)}` : 'Never ran'}</span>
      </div>
      {scriptOpen ? (
        <div className="workflow-script-review">
          <pre className="workflow-script-view" aria-label={`Script for ${workflow.name}`}>{workflow.script}</pre>
        </div>
      ) : null}
      {lastRun && !expanded ? (
        <div className="automation-last-run"><RunCard run={lastRun} /></div>
      ) : null}
      {expanded ? (
        <div className="automation-runs">
          {runs.length > 0 ? runs.map((run) => <RunCard key={run.id} run={run} />) : <div className="command-empty">No runs yet.</div>}
        </div>
      ) : null}
      <div className="site-card-actions">
        {awaitingApproval ? (
          <button
            className="site-publish-btn"
            title="Read the script above, then enable its triggers."
            onClick={() => void act(() => OpenCode.updateWorkflow(workflow.id, { enabled: true }))}
          >
            Approve &amp; enable
          </button>
        ) : (
          <button className="btn-ghost" onClick={() => void act(() => OpenCode.updateWorkflow(workflow.id, { enabled: !workflow.enabled }))}>
            {workflow.enabled ? 'Disable' : 'Enable'}
          </button>
        )}
        <button className="btn-ghost" onClick={() => void act(() => OpenCode.runWorkflow(workflow.id))}>
          <SendIcon size={13} /> Run now
        </button>
        <button className="btn-ghost" onClick={() => setScriptOpen((value) => !value)}>
          {scriptOpen ? 'Hide script' : 'Review script'}
        </button>
        <button
          className="btn-ghost"
          disabled={!sameProject}
          title={sameProject ? 'Open a conversation that edits this workflow with the boss_workflow tools.' : 'Open this workflow’s project to refine it.'}
          onClick={onRefine}
        >
          <ChatIcon size={13} /> Refine with agent
        </button>
        <button className="btn-ghost" onClick={() => setExpanded((value) => !value)}>
          <ChevronIcon size={13} /> {expanded ? 'Hide runs' : `Runs (${runs.length})`}
        </button>
        <button
          className="btn-ghost"
          onClick={() =>
            appStore.setState({
              confirm: {
                title: 'Delete workflow?',
                message: `Delete "${workflow.name}" and its run history? Step threads and clean worktrees are removed with it.`,
                confirmLabel: 'Delete',
                destructive: true,
                action: () => void act(() => OpenCode.deleteWorkflow(workflow.id))
              }
            })
          }
        >
          <TrashIcon size={13} /> Delete
        </button>
      </div>
    </div>
  )
}

export function WorkflowsPage(): React.JSX.Element {
  const snapshot = useStore(appStore, (s) => s.workflows)
  const [composer, setComposer] = useState<{ refine?: { id: string; name: string } } | null>(null)

  useEffect(() => {
    void refreshWorkflows()
  }, [])

  const workflows = snapshot?.workflows ?? []
  const approvalMode: WorkflowApprovalMode = snapshot?.approvalMode ?? 'ask'
  const runsByWorkflow = useMemo(() => {
    const map = new Map<string, WorkflowRun[]>()
    for (const run of snapshot?.runs ?? []) {
      map.set(run.workflowId, [...(map.get(run.workflowId) ?? []), run])
    }
    for (const list of map.values()) list.sort((a, b) => b.startedAt - a.startedAt)
    return map
  }, [snapshot])
  const awaiting = workflows.filter((workflow) => !workflow.enabled && workflow.source === 'agent')

  const setApproval = (mode: WorkflowApprovalMode): void => {
    void OpenCode.setWorkflowApprovalMode(mode)
      .catch((error) => appStore.setState({ lastError: error instanceof Error ? error.message : String(error) }))
      .then(() => refreshWorkflows())
  }

  return (
    <div className="product-page automations-page workflows-page">
      <header className="product-header">
        <div>
          <span className="product-eyebrow">BOSS</span>
          <h1>Workflows</h1>
          <p>
            Durable scripts agents write and the engine runs — journaled steps, restarts survived, budgets enforced.
            Your job here is reviewing, approving, and watching: describe what you want and an agent authors it.
          </p>
        </div>
        <button className="site-publish-btn" onClick={() => setComposer({})}>
          <PlusIcon size={14} /> New workflow
        </button>
      </header>

      <div className="automations-main">
        {composer ? (
          <div className="command-section">
            <div className="command-section-head"><h2>{composer.refine ? 'Refine with an agent' : 'Ask an agent for a workflow'}</h2></div>
            <DescribeComposer refine={composer.refine} onClose={() => setComposer(null)} />
          </div>
        ) : null}

        <div className="command-section">
          <div className="command-section-head">
            <h2>Approval</h2>
          </div>
          <label className="settings-row">
            <span className="settings-row-label">Agent-authored workflows</span>
            <select
              className="settings-select"
              aria-label="Workflow approval mode"
              value={approvalMode}
              onChange={(event) => setApproval(event.target.value === 'auto' ? 'auto' : 'ask')}
            >
              <option value="ask">Ask — stay disabled until I review and enable them</option>
              <option value="auto">Auto — go live as soon as an agent saves them</option>
            </select>
          </label>
          {awaiting.length > 0 ? (
            <div className="automation-hint">
              {awaiting.length === 1
                ? `"${awaiting[0].name}" is waiting for your review below.`
                : `${awaiting.length} workflows are waiting for your review below.`}
            </div>
          ) : null}
        </div>

        <div className="command-section">
          <div className="command-section-head">
            <h2>All workflows</h2>
            <span>{workflows.length}</span>
          </div>
          <div className="command-list">
            {workflows.length > 0 ? (
              workflows.map((workflow) => (
                <WorkflowCard
                  key={workflow.id}
                  workflow={workflow}
                  runs={runsByWorkflow.get(workflow.id) ?? []}
                  onRefine={() => setComposer({ refine: { id: workflow.id, name: workflow.name } })}
                />
              ))
            ) : (
              <div className="command-empty">
                No workflows yet. Describe one — a CI babysitter, a PR review loop, a Datadog watcher — and an agent will
                write, test, and hand it back for your approval.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
