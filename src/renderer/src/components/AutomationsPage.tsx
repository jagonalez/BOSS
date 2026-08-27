import React, { useEffect, useMemo, useState } from 'react'
import { useStore, appStore } from '../state/AppState'
import type { Automation, AutomationInput, AutomationNotifyMode, AutomationRun, AutomationWebhookEvent, AutomationWebhookTrigger } from '@shared/automation'
import { AUTOMATION_DEFAULTS } from '@shared/automation'
import { AUTOMATION_WEBHOOK_EVENTS } from '@shared/automation-trigger'
import type { BackendId, BackendModeId } from '@shared/backend'
import { OpenCode } from '../lib/opencode'
import { refreshAutomations, refreshBackendModels, selectSession } from '../lib/actions'
import { ChatIcon, ChevronIcon, PlusIcon, ReloadIcon, RenameIcon, SendIcon, StopIcon, TrashIcon } from './icons'
import { ModelSelect } from './ModelSelect'

const WEBHOOK_EVENT_LABELS: Record<AutomationWebhookEvent, string> = {
  push: 'Push',
  pull_request: 'Pull request opened'
}

function webhookTriggerLabel(trigger: AutomationWebhookTrigger): string {
  if (!trigger.events.length) return 'Any GitHub event'
  return trigger.events.map((event) => WEBHOOK_EVENT_LABELS[event]).join(', ')
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return 'now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

function duration(run: AutomationRun): string {
  if (!run.finishedAt) return '…'
  const seconds = Math.max(1, Math.round((run.finishedAt - run.startedAt) / 1_000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

type SchedulePreset = 'manual' | 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'custom'

interface ScheduleDraft {
  preset: SchedulePreset
  time: string
  weekday: number
  cron: string
}

function draftFromExpression(expression: string | undefined, kind: 'cron' | 'manual'): ScheduleDraft {
  const draft: ScheduleDraft = { preset: 'manual', time: '09:00', weekday: 1, cron: expression ?? '0 9 * * *' }
  if (kind !== 'cron' || !expression) return draft
  const daily = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(expression)
  const weekdays = /^(\d{1,2}) (\d{1,2}) \* \* 1-5$/.exec(expression)
  const weekly = /^(\d{1,2}) (\d{1,2}) \* \* (\d)$/.exec(expression)
  if (expression === '0 * * * *') return { ...draft, preset: 'hourly' }
  if (daily) return { ...draft, preset: 'daily', time: `${pad(Number(daily[2]))}:${pad(Number(daily[1]))}` }
  if (weekdays) return { ...draft, preset: 'weekdays', time: `${pad(Number(weekdays[2]))}:${pad(Number(weekdays[1]))}` }
  if (weekly) {
    return { ...draft, preset: 'weekly', time: `${pad(Number(weekly[2]))}:${pad(Number(weekly[1]))}`, weekday: Number(weekly[3]) }
  }
  return { ...draft, preset: 'custom' }
}

function scheduleFromDraft(draft: ScheduleDraft): { kind: 'cron' | 'manual'; expression?: string } {
  if (draft.preset === 'manual') return { kind: 'manual' }
  const [hour, minute] = draft.time.split(':').map(Number)
  switch (draft.preset) {
    case 'hourly': return { kind: 'cron', expression: '0 * * * *' }
    case 'daily': return { kind: 'cron', expression: `${minute} ${hour} * * *` }
    case 'weekdays': return { kind: 'cron', expression: `${minute} ${hour} * * 1-5` }
    case 'weekly': return { kind: 'cron', expression: `${minute} ${hour} * * ${draft.weekday}` }
    default: return { kind: 'cron', expression: draft.cron.trim() }
  }
}

function scheduleLabel(automation: Automation): string {
  if (automation.webhook) return `GitHub webhook · ${webhookTriggerLabel(automation.webhook)}${automation.webhook.branch ? ` → ${automation.webhook.branch}` : ''}`
  if (automation.schedule.kind === 'manual') return 'Manual only'
  const draft = draftFromExpression(automation.schedule.expression, 'cron')
  switch (draft.preset) {
    case 'hourly': return 'Every hour'
    case 'daily': return `Every day at ${draft.time}`
    case 'weekdays': return `Weekdays at ${draft.time}`
    case 'weekly': return `${WEEKDAYS[draft.weekday]} at ${draft.time}`
    default: return `Cron: ${automation.schedule.expression}`
  }
}

interface EditorState {
  id?: string
  name: string
  prompt: string
  projectPath: string
  backendId: BackendId
  modelKey: string
  mode: BackendModeId
  triggerKind: 'schedule' | 'github'
  schedule: ScheduleDraft
  webhookEvents: AutomationWebhookEvent[]
  webhookBranch: string
  workspace: 'worktree' | 'project'
  overlapPolicy: 'skip' | 'queue'
  catchUp: boolean
  notify: AutomationNotifyMode
  maxRunMinutes: number
  keepRuns: number
}

function emptyEditor(projectPath: string, backendId: BackendId): EditorState {
  return {
    name: '',
    prompt: '',
    projectPath,
    backendId,
    modelKey: '',
    mode: AUTOMATION_DEFAULTS.mode,
    triggerKind: 'schedule',
    schedule: { preset: 'daily', time: '09:00', weekday: 1, cron: '0 9 * * *' },
    webhookEvents: ['push'],
    webhookBranch: '',
    workspace: 'worktree',
    overlapPolicy: AUTOMATION_DEFAULTS.overlapPolicy,
    catchUp: AUTOMATION_DEFAULTS.catchUp,
    notify: AUTOMATION_DEFAULTS.notify,
    maxRunMinutes: AUTOMATION_DEFAULTS.maxRunMinutes,
    keepRuns: AUTOMATION_DEFAULTS.keepRuns
  }
}

function editorFromAutomation(automation: Automation): EditorState {
  return {
    id: automation.id,
    name: automation.name,
    prompt: automation.prompt,
    projectPath: automation.projectPath,
    backendId: automation.backendId,
    modelKey: automation.model ? `${automation.model.providerID}/${automation.model.modelID}` : '',
    mode: automation.mode,
    triggerKind: automation.webhook ? 'github' : 'schedule',
    schedule: draftFromExpression(automation.schedule.expression, automation.schedule.kind),
    webhookEvents: automation.webhook ? [...automation.webhook.events] : ['push'],
    webhookBranch: automation.webhook?.branch ?? '',
    workspace: automation.workspace === 'none' ? 'worktree' : automation.workspace,
    overlapPolicy: automation.overlapPolicy,
    catchUp: automation.catchUp,
    notify: automation.notify,
    maxRunMinutes: automation.maxRunMinutes,
    keepRuns: automation.keepRuns
  }
}

function RunRow({ run }: { run: AutomationRun }): React.JSX.Element {
  const label = run.status === 'running' ? 'Running' : run.status
  return (
    <div className={`automation-run status-${run.status}${run.needsAttention ? ' attention' : ''}`}>
      <span className={`site-badge automation-badge status-${run.status}`}>{label}</span>
      <div className="automation-run-main">
        <span className="automation-run-summary">
          {run.needsAttention ? 'Waiting on input — open the thread. ' : ''}
          {run.summary ?? run.error ?? (run.status === 'running' ? 'The agent is working…' : 'No summary.')}
        </span>
        <small>
          {run.trigger} · {timeAgo(run.startedAt)} · {duration(run)}
          {run.changedFiles > 0 ? ` · ${run.changedFiles} file${run.changedFiles === 1 ? '' : 's'} changed` : ''}
        </small>
      </div>
      {run.threadId ? (
        <button className="btn-ghost" onClick={() => selectSession(run.threadId!, false)} title="Open the run thread">
          <ChatIcon size={13} /> Thread
        </button>
      ) : null}
    </div>
  )
}

function AutomationEditor({ editor, onClose }: { editor: EditorState; onClose: () => void }): React.JSX.Element {
  const backends = useStore(appStore, (s) => s.backends)
  const backendModels = useStore(appStore, (s) => s.backendModels)
  const projects = useStore(appStore, (s) => s.projects)
  const projectPath = useStore(appStore, (s) => s.projectPath)
  const [draft, setDraft] = useState(editor)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hookUrl, setHookUrl] = useState('')
  const [hookVersion, setHookVersion] = useState(0)

  const patch = (partial: Partial<EditorState>): void => setDraft((current) => ({ ...current, ...partial }))
  const backend = backends.find((item) => item.id === draft.backendId)
  const models = backendModels[draft.backendId] ?? []
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

  useEffect(() => {
    if (!draft.id || draft.triggerKind !== 'github') {
      setHookUrl('')
      return
    }
    let cancelled = false
    OpenCode.automationWebhookToken(draft.id)
      .then((hook) => {
        if (!cancelled) setHookUrl(hook.url)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [draft.id, draft.triggerKind, hookVersion])

  const toggleWebhookEvent = (event: AutomationWebhookEvent): void => {
    const active = draft.webhookEvents.includes(event)
    patch({ webhookEvents: active ? draft.webhookEvents.filter((item) => item !== event) : [...draft.webhookEvents, event] })
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    const model = draft.modelKey
      ? { providerID: draft.modelKey.split('/')[0], modelID: draft.modelKey.split('/').slice(1).join('/') }
      : undefined
    const github = draft.triggerKind === 'github'
    const webhook: AutomationInput['webhook'] = github
      ? {
          events: draft.webhookEvents,
          ...(draft.webhookBranch.trim() ? { branch: draft.webhookBranch.trim() } : {})
        }
      : null
    const input: AutomationInput = {
      name: draft.name,
      prompt: draft.prompt,
      projectPath: draft.projectPath,
      backendId: draft.backendId,
      model,
      mode: draft.mode,
      schedule: github ? { kind: 'manual' } : scheduleFromDraft(draft.schedule),
      webhook,
      workspace: draft.projectPath ? draft.workspace : 'none',
      overlapPolicy: draft.overlapPolicy,
      catchUp: draft.catchUp,
      notify: draft.notify,
      maxRunMinutes: draft.maxRunMinutes,
      keepRuns: draft.keepRuns
    }
    try {
      if (github && !draft.webhookEvents.length) throw new Error('Pick at least one GitHub event to fire this automation.')
      const saved = draft.id
        ? await OpenCode.updateAutomation(draft.id, input)
        : await OpenCode.createAutomation(input)
      await refreshAutomations()
      if (github) {
        // Stay open so the freshly generated URL can be copied into GitHub.
        patch({ id: saved.id })
        setHookVersion((value) => value + 1)
      } else {
        onClose()
      }
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
        <input className="settings-input" value={draft.name} placeholder="Morning changelog report" onChange={(e) => patch({ name: e.target.value })} />
      </label>
      <label className="settings-row automation-prompt-row">
        <span className="settings-row-label">Prompt</span>
        <textarea
          className="settings-input automation-prompt"
          rows={5}
          value={draft.prompt}
          placeholder="What should the agent do on every run?"
          onChange={(e) => patch({ prompt: e.target.value })}
        />
      </label>
      <label className="settings-row">
        <span className="settings-row-label">Project</span>
        <select
          className="settings-select"
          value={draft.projectPath}
          onChange={(e) => patch({ projectPath: e.target.value })}
        >
          <option value="">No project (global)</option>
          {projectPaths.map((path) => <option key={path} value={path}>{path}</option>)}
        </select>
      </label>
      {draft.projectPath ? (
        <label className="settings-row">
          <span className="settings-row-label">Workspace</span>
          <select
            className="settings-select"
            value={draft.workspace}
            onChange={(e) => patch({ workspace: e.target.value as EditorState['workspace'] })}
          >
            <option value="worktree">Fresh git worktree per run (recommended)</option>
            <option value="project">Project folder (for read-only tasks)</option>
          </select>
        </label>
      ) : null}
      <label className="settings-row">
        <span className="settings-row-label">Backend</span>
        <select
          className="settings-select"
          value={draft.backendId}
          onChange={(e) => {
            const backendId = e.target.value as BackendId
            const modes = backends.find((item) => item.id === backendId)?.modes ?? []
            const mode = modes.some((item) => item.id === draft.mode) ? draft.mode : modes[0]?.id ?? 'auto'
            patch({ backendId, modelKey: '', mode })
          }}
        >
          {backends.filter((item) => item.available).map((item) => (
            <option key={item.id} value={item.id}>{item.label}</option>
          ))}
        </select>
      </label>
      <div className="settings-row">
        <span className="settings-row-label">Model</span>
        <ModelSelect
          backendId={draft.backendId}
          models={models}
          selected={draft.modelKey
            ? { providerID: draft.modelKey.split('/')[0], modelID: draft.modelKey.split('/').slice(1).join('/') }
            : undefined}
          emptyLabel="Backend default"
          onPick={(model) => patch({ modelKey: model ? `${model.provider || draft.backendId}/${model.id}` : '' })}
        />
      </div>
      <label className="settings-row">
        <span className="settings-row-label">Mode</span>
        <select className="settings-select" value={draft.mode} onChange={(e) => patch({ mode: e.target.value as BackendModeId })}>
          {(backend?.modes ?? []).map((mode) => <option key={mode.id} value={mode.id}>{mode.label}</option>)}
        </select>
      </label>
      {draft.mode === 'ask' || draft.mode === 'plan' ? (
        <div className="automation-hint">Runs are unattended. "{backend?.modes.find((m) => m.id === draft.mode)?.label}" mode can stall or block the run; prefer an automatic mode.</div>
      ) : null}
      <label className="settings-row">
        <span className="settings-row-label">Trigger</span>
        <select
          className="settings-select"
          value={draft.triggerKind}
          onChange={(e) => patch({ triggerKind: e.target.value as EditorState['triggerKind'] })}
        >
          <option value="schedule">Schedule or manual</option>
          <option value="github">GitHub webhook</option>
        </select>
      </label>
      {draft.triggerKind === 'github' ? (
        <>
          <div className="settings-row">
            <span className="settings-row-label">Fire on</span>
            <div className="automation-webhook-events">
              {AUTOMATION_WEBHOOK_EVENTS.map((event) => (
                <label key={event} className="settings-check">
                  <input
                    type="checkbox"
                    checked={draft.webhookEvents.includes(event)}
                    onChange={() => toggleWebhookEvent(event)}
                  />
                  <span>{WEBHOOK_EVENT_LABELS[event]}</span>
                </label>
              ))}
              {draft.webhookEvents.length === 0 ? (
                <div className="automation-hint">With nothing checked, every supported event fires the run.</div>
              ) : null}
            </div>
          </div>
          <label className="settings-row">
            <span className="settings-row-label">Branch filter</span>
            <input
              className="settings-input"
              value={draft.webhookBranch}
              placeholder="Any branch (or name one, e.g. main)"
              onChange={(e) => patch({ webhookBranch: e.target.value })}
            />
          </label>
          {hookUrl ? (
            <div className="settings-row" aria-label="Webhook URL">
              <span className="settings-row-label">Webhook URL</span>
              <code className="automation-hook-url">{hookUrl}</code>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => window.boss.clipboardWrite(hookUrl)}
                title="Copy the webhook URL for this automation"
              >
                Copy
              </button>
            </div>
          ) : (
            <div className="automation-hint">Save the automation to generate its secret webhook URL, then add it in GitHub → Settings → Webhooks.</div>
          )}
          <div className="automation-hint">
            The prompt can use delivery variables like {'{{event}}'}, {'{{branch}}'}, {'{{pr_title}}'} — they are filled from each GitHub payload.
          </div>
        </>
      ) : null}
      <label className="settings-row">
        <span className="settings-row-label">Schedule</span>
        <select
          className="settings-select"
          value={draft.schedule.preset}
          disabled={draft.triggerKind === 'github'}
          onChange={(e) => patch({ schedule: { ...draft.schedule, preset: e.target.value as SchedulePreset } })}
        >
          <option value="manual">Manual only</option>
          <option value="hourly">Every hour</option>
          <option value="daily">Every day</option>
          <option value="weekdays">Weekdays</option>
          <option value="weekly">Once a week</option>
          <option value="custom">Custom cron</option>
        </select>
      </label>
      {draft.triggerKind !== 'github' && draft.schedule.preset === 'weekly' ? (
        <label className="settings-row">
          <span className="settings-row-label">Day</span>
          <select
            className="settings-select"
            value={draft.schedule.weekday}
            onChange={(e) => patch({ schedule: { ...draft.schedule, weekday: Number(e.target.value) } })}
          >
            {WEEKDAYS.map((day, index) => <option key={day} value={index}>{day}</option>)}
          </select>
        </label>
      ) : null}
      {draft.triggerKind !== 'github' && ['daily', 'weekdays', 'weekly'].includes(draft.schedule.preset) ? (
        <label className="settings-row">
          <span className="settings-row-label">Time</span>
          <input
            type="time"
            className="settings-input"
            value={draft.schedule.time}
            onChange={(e) => patch({ schedule: { ...draft.schedule, time: e.target.value || '09:00' } })}
          />
        </label>
      ) : null}
      {draft.triggerKind !== 'github' && draft.schedule.preset === 'custom' ? (
        <label className="settings-row">
          <span className="settings-row-label">Cron</span>
          <input
            className="settings-input"
            value={draft.schedule.cron}
            placeholder="minute hour day month weekday"
            onChange={(e) => patch({ schedule: { ...draft.schedule, cron: e.target.value } })}
          />
        </label>
      ) : null}
      <details className="automation-advanced">
        <summary>Advanced</summary>
        <label className="settings-row">
          <span className="settings-row-label">If a run is still active</span>
          <select
            className="settings-select"
            value={draft.overlapPolicy}
            onChange={(e) => patch({ overlapPolicy: e.target.value as EditorState['overlapPolicy'] })}
          >
            <option value="skip">Skip the new run</option>
            <option value="queue">Queue it after the active run</option>
          </select>
        </label>
        <label className="settings-row">
          <span className="settings-row-label">Stop a run after (minutes)</span>
          <input
            type="number"
            className="settings-input"
            min={1}
            max={1440}
            value={draft.maxRunMinutes}
            onChange={(e) => patch({ maxRunMinutes: Number(e.target.value) })}
          />
        </label>
        <label className="settings-row">
          <span className="settings-row-label">Keep run history</span>
          <input
            type="number"
            className="settings-input"
            min={1}
            max={500}
            value={draft.keepRuns}
            onChange={(e) => patch({ keepRuns: Number(e.target.value) })}
          />
        </label>
        <label className="settings-check">
          <input type="checkbox" checked={draft.catchUp} onChange={(e) => patch({ catchUp: e.target.checked })} />
          <span>Run once at launch when a scheduled run was missed</span>
        </label>
        <label className="settings-row">
          <span className="settings-row-label">Notifications</span>
          <select className="settings-select" value={draft.notify} onChange={(e) => patch({ notify: e.target.value as AutomationNotifyMode })}>
            <option value="events">Failures and runs that change files</option>
            <option value="always">Every run (good for digests)</option>
            <option value="off">Off</option>
          </select>
        </label>
      </details>
      {error ? <div className="automation-error">{error}</div> : null}
      <div className="automation-editor-actions">
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn-allow" disabled={saving || !draft.name.trim() || !draft.prompt.trim()} onClick={() => void save()}>
          {saving ? 'Saving…' : draft.id ? 'Save changes' : 'Create automation'}
        </button>
      </div>
    </div>
  )
}

function AutomationCard({
  automation,
  runs,
  onEdit
}: {
  automation: Automation
  runs: AutomationRun[]
  onEdit: () => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const running = runs.some((run) => run.status === 'running')
  const lastRun = runs[0]
  const statusLine = [
    running ? 'Running now' : automation.enabled
      ? automation.webhook
        ? scheduleLabel(automation)
        : automation.nextRunAt ? `Next run ${new Date(automation.nextRunAt).toLocaleString()}` : scheduleLabel(automation)
      : 'Paused',
    automation.missedRuns > 0 ? `${automation.missedRuns} missed` : '',
    automation.lastWebhookAt ? `Webhook ${timeAgo(automation.lastWebhookAt)}` : ''
  ].filter(Boolean).join(' · ')

  const act = async (action: () => Promise<unknown>): Promise<void> => {
    try {
      await action()
    } catch (err) {
      appStore.setState({ lastError: err instanceof Error ? err.message : String(err) })
    }
    await refreshAutomations()
  }

  const copyHookUrl = async (): Promise<void> => {
    const hook = await OpenCode.automationWebhookToken(automation.id)
    if (!hook.url) throw new Error('The webhook endpoint is not running.')
    window.boss.clipboardWrite(hook.url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1_500)
  }

  return (
    <div className={`site-card automation-card${running ? ' running' : ''}`}>
      <div className="site-card-head">
        <span className="command-state-icon"><ReloadIcon size={14} /></span>
        <div className="command-session-main">
          <strong>{automation.name}</strong>
          <small>{automation.projectPath || 'Global'} · {scheduleLabel(automation)}</small>
          {automation.lastWebhookAt ? (
            <small>Last webhook: {automation.lastWebhookLabel ?? 'unknown event'} · {timeAgo(automation.lastWebhookAt)}</small>
          ) : null}
        </div>
        {running ? <span className="site-badge automation-badge status-running">Running</span> : null}
        {!automation.enabled ? <span className="site-badge">Paused</span> : null}
        <span className="site-time">{statusLine}</span>
      </div>
      {lastRun && !expanded ? (
        <div className="automation-last-run"><RunRow run={lastRun} /></div>
      ) : null}
      {expanded ? (
        <div className="automation-runs">
          {runs.length > 0
            ? runs.map((run) => <RunRow key={run.id} run={run} />)
            : <div className="command-empty">No runs yet.</div>}
        </div>
      ) : null}
      <div className="site-card-actions">
        {running ? (
          <button className="btn-ghost" onClick={() => void act(() => OpenCode.stopAutomation(automation.id))}>
            <StopIcon size={13} /> Stop
          </button>
        ) : (
          <button className="btn-ghost" onClick={() => void act(() => OpenCode.runAutomation(automation.id))}>
            <SendIcon size={13} /> Run now
          </button>
        )}
        <button
          className="btn-ghost"
          onClick={() => {
            if (running && automation.enabled) {
              appStore.setState({
                confirm: {
                  title: 'Pause automation?',
                  message: `"${automation.name}" has an active run. Pause future runs and stop the active run too?`,
                  confirmLabel: 'Pause and stop',
                  destructive: true,
                  action: () => {
                    void act(async () => {
                      await OpenCode.stopAutomation(automation.id).catch(() => {})
                      await OpenCode.updateAutomation(automation.id, { enabled: false })
                    })
                  }
                }
              })
              return
            }
            void act(() => OpenCode.updateAutomation(automation.id, { enabled: !automation.enabled }))
          }}
        >
          {automation.enabled ? 'Pause' : 'Resume'}
        </button>
        <button className="btn-ghost" onClick={onEdit}><RenameIcon size={13} /> Edit</button>
        {automation.webhook ? (
          <button
            className="btn-ghost"
            title="Copy this automation's webhook URL"
            onClick={() => void act(copyHookUrl)}
          >
            <SendIcon size={13} /> {copied ? 'Copied' : 'Copy URL'}
          </button>
        ) : null}
        <button className="btn-ghost" onClick={() => setExpanded((value) => !value)}>
          <ChevronIcon size={13} /> {expanded ? 'Hide runs' : `Runs (${runs.length})`}
        </button>
        <button
          className="btn-ghost"
          onClick={() =>
            appStore.setState({
              confirm: {
                title: 'Delete automation?',
                message: `Delete "${automation.name}" and its run history? Run threads and clean worktrees are removed with it.`,
                confirmLabel: 'Delete',
                destructive: true,
                action: () => void act(() => OpenCode.deleteAutomation(automation.id))
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

export function AutomationsPage(): React.JSX.Element {
  const snapshot = useStore(appStore, (s) => s.automations)
  const backends = useStore(appStore, (s) => s.backends)
  const backendModels = useStore(appStore, (s) => s.backendModels)
  const projectPath = useStore(appStore, (s) => s.projectPath)
  const engine = useStore(appStore, (s) => s.engine)
  const [editor, setEditor] = useState<EditorState | null>(null)

  useEffect(() => {
    void refreshAutomations()
  }, [])

  useEffect(() => {
    if (backends.length > 0 && Object.keys(backendModels).length === 0) void refreshBackendModels()
  }, [backends, backendModels])

  const automations = snapshot?.automations ?? []
  const runsByAutomation = useMemo(() => {
    const map = new Map<string, AutomationRun[]>()
    for (const run of snapshot?.runs ?? []) {
      map.set(run.automationId, [...(map.get(run.automationId) ?? []), run])
    }
    for (const list of map.values()) list.sort((a, b) => b.startedAt - a.startedAt)
    return map
  }, [snapshot])

  return (
    <div className="product-page automations-page">
      <header className="product-header">
        <div>
          <span className="product-eyebrow">BOSS</span>
          <h1>Automations</h1>
          <p>Prompts that run on a schedule — or on demand — against a backend you pick. Every run is a thread you can review and continue. Runs fire while BOSS is open.</p>
        </div>
        <button className="site-publish-btn" onClick={() => setEditor(emptyEditor(projectPath, engine))}>
          <PlusIcon size={14} /> New automation
        </button>
      </header>

      <div className="automations-main">
        {editor ? (
          <div className="command-section">
            <div className="command-section-head"><h2>{editor.id ? 'Edit automation' : 'New automation'}</h2></div>
            <AutomationEditor editor={editor} onClose={() => setEditor(null)} />
          </div>
        ) : null}
        <div className="command-section">
          <div className="command-section-head">
            <h2>Automations</h2>
            <span>{automations.length}</span>
          </div>
          <div className="command-list">
            {automations.length > 0 ? (
              automations.map((automation) => (
                <AutomationCard
                  key={automation.id}
                  automation={automation}
                  runs={runsByAutomation.get(automation.id) ?? []}
                  onEdit={() => setEditor(editorFromAutomation(automation))}
                />
              ))
            ) : (
              <div className="command-empty">
                No automations yet. Create one for a recurring chore — a morning digest, a dependency check, a nightly cleanup.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
