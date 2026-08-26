import React, { useEffect, useMemo, useState } from 'react'
import { useStore, appStore } from '../state/AppState'
import type { JournalEntry, Workflow, WorkflowInput, WorkflowRun, WorkflowTrigger } from '@shared/workflow'
import { OpenCode } from '../lib/opencode'
import { refreshWorkflows, selectSession } from '../lib/actions'
import { BranchIcon, ChatIcon, ChevronIcon, PlusIcon, RenameIcon, SendIcon, StopIcon, TrashIcon } from './icons'

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

const EXAMPLE_SCRIPT = `// Steps are journaled: this run survives BOSS restarts mid-sequence.
const outcome = await agent('Describe the task for the agent conversation here.')
if (outcome.status !== 'success') {
  await notify('The step failed: ' + (outcome.error ?? outcome.status), { attention: true })
  return outcome.status
}
return outcome.summary`

interface EditorState {
  id?: string
  name: string
  description: string
  projectPath: string
  script: string
  cron: string
  eventType: string
  eventFilters: string
  maxAgentRuns: string
  maxNotifies: string
  maxRunHours: string
}

function emptyEditor(projectPath: string): EditorState {
  return {
    name: '',
    description: '',
    projectPath,
    script: EXAMPLE_SCRIPT,
    cron: '',
    eventType: '',
    eventFilters: '',
    maxAgentRuns: '',
    maxNotifies: '',
    maxRunHours: ''
  }
}

function editorFromWorkflow(workflow: Workflow): EditorState {
  const cron = workflow.triggers.find((trigger): trigger is Extract<WorkflowTrigger, { kind: 'cron' }> => trigger.kind === 'cron')
  const event = workflow.triggers.find((trigger): trigger is Extract<WorkflowTrigger, { kind: 'event' }> => trigger.kind === 'event')
  return {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description ?? '',
    projectPath: workflow.projectPath,
    script: workflow.script,
    cron: cron?.expression ?? '',
    eventType: event?.pattern.type ?? '',
    eventFilters: event?.pattern.filters ? JSON.stringify(event.pattern.filters) : '',
    maxAgentRuns: workflow.budget?.maxAgentRuns !== undefined ? String(workflow.budget.maxAgentRuns) : '',
    maxNotifies: workflow.budget?.maxNotifies !== undefined ? String(workflow.budget.maxNotifies) : '',
    maxRunHours: workflow.budget?.maxRunHours !== undefined ? String(workflow.budget.maxRunHours) : ''
  }
}

function inputFromEditor(draft: EditorState): WorkflowInput {
  const triggers: WorkflowTrigger[] = []
  if (draft.cron.trim()) triggers.push({ kind: 'cron', expression: draft.cron.trim() })
  if (draft.eventType.trim()) {
    let filters: Record<string, string | number | boolean> | undefined
    if (draft.eventFilters.trim()) {
      const parsed: unknown = JSON.parse(draft.eventFilters)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Event filters must be a JSON object.')
      filters = Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).filter(
          (entry): entry is [string, string | number | boolean] => ['string', 'number', 'boolean'].includes(typeof entry[1])
        )
      )
    }
    triggers.push({ kind: 'event', pattern: { type: draft.eventType.trim(), ...(filters && Object.keys(filters).length ? { filters } : {}) } })
  }
  const budget: WorkflowInput['budget'] = {}
  if (draft.maxAgentRuns.trim()) budget.maxAgentRuns = Math.max(1, Math.round(Number(draft.maxAgentRuns)))
  if (draft.maxNotifies.trim()) budget.maxNotifies = Math.max(1, Math.round(Number(draft.maxNotifies)))
  if (draft.maxRunHours.trim()) budget.maxRunHours = Math.max(1, Math.round(Number(draft.maxRunHours)))
  return {
    name: draft.name,
    ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
    projectPath: draft.projectPath,
    script: draft.script,
    triggers,
    overlapPolicy: 'skip',
    ...(Object.keys(budget).length ? { budget } : {})
  }
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

function WorkflowEditor({ editor, onClose }: { editor: EditorState; onClose: () => void }): React.JSX.Element {
  const projects = useStore(appStore, (s) => s.projects)
  const projectPath = useStore(appStore, (s) => s.projectPath)
  const [draft, setDraft] = useState(editor)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const patch = (partial: Partial<EditorState>): void => setDraft((current) => ({ ...current, ...partial }))

  const projectPaths = useMemo(() => {
    const paths = new Set<string>()
    if (projectPath) paths.add(projectPath)
    for (const project of projects) {
      const path = project.worktree ?? project.directory ?? project.path
      if (path && path !== '/') paths.add(path)
    }
    if (draft.projectPath) paths.add(draft.projectPath)
    return [...paths]
  }, [projects, projectPath, draft.projectPath])

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      const input = inputFromEditor(draft)
      if (draft.id) await OpenCode.updateWorkflow(draft.id, input)
      else await OpenCode.createWorkflow(input)
      await refreshWorkflows()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="automation-editor">
      <label className="settings-row">
        <span className="settings-row-label">Name</span>
        <input
          className="settings-input"
          value={draft.name}
          placeholder="Datadog alert watcher"
          onChange={(event) => patch({ name: event.target.value })}
        />
      </label>
      <label className="settings-row">
        <span className="settings-row-label">Description</span>
        <input
          className="settings-input"
          value={draft.description}
          placeholder="What it watches, and when it pings you"
          onChange={(event) => patch({ description: event.target.value })}
        />
      </label>
      <label className="settings-row">
        <span className="settings-row-label">Project</span>
        <select className="settings-select" value={draft.projectPath} onChange={(event) => patch({ projectPath: event.target.value })}>
          <option value="">No project (global)</option>
          {projectPaths.map((path) => (
            <option key={path} value={path}>{path}</option>
          ))}
        </select>
      </label>
      <label className="settings-row automation-prompt-row">
        <span className="settings-row-label">Script</span>
        <textarea
          className="settings-input automation-prompt workflow-script"
          rows={14}
          spellCheck={false}
          value={draft.script}
          onChange={(event) => patch({ script: event.target.value })}
        />
      </label>
      <label className="settings-row">
        <span className="settings-row-label">Cron trigger</span>
        <input
          className="settings-input"
          value={draft.cron}
          placeholder="*/20 * * * * — optional; leave empty for manual or event-only"
          onChange={(event) => patch({ cron: event.target.value })}
        />
      </label>
      <label className="settings-row">
        <span className="settings-row-label">Event trigger</span>
        <input
          className="settings-input"
          value={draft.eventType}
          placeholder="github.pull_request — optional"
          onChange={(event) => patch({ eventType: event.target.value })}
        />
      </label>
      {draft.eventType.trim() ? (
        <label className="settings-row">
          <span className="settings-row-label">Event filters</span>
          <input
            className="settings-input"
            value={draft.eventFilters}
            placeholder='{"branch": "main"} — JSON, matched against event data'
            onChange={(event) => patch({ eventFilters: event.target.value })}
          />
        </label>
      ) : null}
      <label className="settings-row">
        <span className="settings-row-label">Budget</span>
        <span className="workflow-budget-row">
          <input
            className="settings-input"
            value={draft.maxAgentRuns}
            placeholder="Agent runs (10)"
            onChange={(event) => patch({ maxAgentRuns: event.target.value })}
          />
          <input
            className="settings-input"
            value={draft.maxNotifies}
            placeholder="Notifications (5)"
            onChange={(event) => patch({ maxNotifies: event.target.value })}
          />
          <input
            className="settings-input"
            value={draft.maxRunHours}
            placeholder="Run hours (72)"
            onChange={(event) => patch({ maxRunHours: event.target.value })}
          />
        </span>
      </label>
      {error ? <div className="automation-error">{error}</div> : null}
      <div className="automation-editor-actions">
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="site-publish-btn" disabled={saving || !draft.name.trim() || !draft.script.trim()} onClick={() => void save()}>
          {draft.id ? 'Save workflow' : 'Create workflow'}
        </button>
      </div>
    </div>
  )
}

function WorkflowCard({
  workflow,
  runs,
  onEdit
}: {
  workflow: Workflow
  runs: WorkflowRun[]
  onEdit: () => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const active = runs.find(isActiveRun)
  const lastRun = runs[0]

  const act = async (action: () => Promise<unknown>): Promise<void> => {
    try {
      await action()
    } catch (error) {
      appStore.setState({ lastError: error instanceof Error ? error.message : String(error) })
    }
    await refreshWorkflows()
  }

  return (
    <div className={`site-card automation-card${active ? ' running' : ''}`}>
      <div className="site-card-head">
        <span className="command-state-icon"><BranchIcon size={14} /></span>
        <div className="command-session-main">
          <strong>{workflow.name}</strong>
          <small>{workflow.projectPath || 'Global'} · {triggersLabel(workflow)}</small>
          {workflow.description ? <small>{workflow.description}</small> : null}
        </div>
        {active ? <span className="site-badge automation-badge status-running">{active.status}</span> : null}
        {!workflow.enabled ? (
          <span className="site-badge" title="Triggers are dormant until you enable this workflow.">
            {workflow.source === 'agent' ? 'Awaiting approval' : 'Paused'}
          </span>
        ) : null}
        {workflow.source === 'agent' ? <span className="site-badge">Agent-authored</span> : null}
        <span className="site-time">{workflow.lastRunAt ? `Ran ${timeAgo(workflow.lastRunAt)}` : 'Never ran'}</span>
      </div>
      {lastRun && !expanded ? (
        <div className="automation-last-run"><RunCard run={lastRun} /></div>
      ) : null}
      {expanded ? (
        <div className="automation-runs">
          {runs.length > 0 ? runs.map((run) => <RunCard key={run.id} run={run} />) : <div className="command-empty">No runs yet.</div>}
        </div>
      ) : null}
      <div className="site-card-actions">
        <button className="btn-ghost" onClick={() => void act(() => OpenCode.runWorkflow(workflow.id))}>
          <SendIcon size={13} /> Run now
        </button>
        <button className="btn-ghost" onClick={() => void act(() => OpenCode.updateWorkflow(workflow.id, { enabled: !workflow.enabled }))}>
          {workflow.enabled ? 'Disable' : 'Enable'}
        </button>
        <button className="btn-ghost" onClick={onEdit}><RenameIcon size={13} /> Edit</button>
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
  const projectPath = useStore(appStore, (s) => s.projectPath)
  const [editor, setEditor] = useState<EditorState | null>(null)

  useEffect(() => {
    void refreshWorkflows()
  }, [])

  const workflows = snapshot?.workflows ?? []
  const runsByWorkflow = useMemo(() => {
    const map = new Map<string, WorkflowRun[]>()
    for (const run of snapshot?.runs ?? []) {
      map.set(run.workflowId, [...(map.get(run.workflowId) ?? []), run])
    }
    for (const list of map.values()) list.sort((a, b) => b.startedAt - a.startedAt)
    return map
  }, [snapshot])

  return (
    <div className="product-page automations-page workflows-page">
      <header className="product-header">
        <div>
          <span className="product-eyebrow">BOSS</span>
          <h1>Workflows</h1>
          <p>
            Durable scripts over agents, judges, events, and timers. Every step is journaled, so a run survives BOSS
            restarts and resumes exactly where it left off. Agents can author workflows too — those wait here, disabled,
            until you enable them.
          </p>
        </div>
        <button className="site-publish-btn" onClick={() => setEditor(emptyEditor(projectPath))}>
          <PlusIcon size={14} /> New workflow
        </button>
      </header>

      <div className="automations-main">
        {editor ? (
          <div className="command-section">
            <div className="command-section-head"><h2>{editor.id ? 'Edit workflow' : 'New workflow'}</h2></div>
            <WorkflowEditor editor={editor} onClose={() => setEditor(null)} />
          </div>
        ) : null}
        <div className="command-section">
          <div className="command-section-head">
            <h2>Workflows</h2>
            <span>{workflows.length}</span>
          </div>
          <div className="command-list">
            {workflows.length > 0 ? (
              workflows.map((workflow) => (
                <WorkflowCard
                  key={workflow.id}
                  workflow={workflow}
                  runs={runsByWorkflow.get(workflow.id) ?? []}
                  onEdit={() => setEditor(editorFromWorkflow(workflow))}
                />
              ))
            ) : (
              <div className="command-empty">
                No workflows yet. Create one for anything that must outlive a conversation — a CI babysitter, a PR review
                loop, a Datadog watcher — or ask an agent to write one for you.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
