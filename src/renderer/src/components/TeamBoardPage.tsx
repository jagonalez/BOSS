import React, { useEffect, useMemo, useState } from 'react'
import type { BackendId } from '@shared/backend'
import type { MobileAccessStatus } from '@shared/mobile'
import {
  TEAM_TASK_STATUSES,
  type TeamSnapshot,
  type TeamTask,
  type TeamTaskInput,
  type TeamTaskPatch,
  type TeamTaskStatus
} from '@shared/team'
import { appStore, useStore } from '../state/AppState'
import { OpenCode } from '../lib/opencode'
import { errorSummary } from '../lib/errors'
import { openProject, refreshSessions, refreshTeamBoard, selectSession } from '../lib/actions'
import { BACKEND_SHORT_LABELS } from '../lib/backend-labels'
import { CopyIcon, PlusIcon, TeamIcon, TrashIcon } from './icons'

const COLUMNS: Array<{ status: TeamTaskStatus; label: string; hint: string }> = [
  { status: 'proposed', label: 'Proposed', hint: 'Ideas to discuss' },
  { status: 'ready', label: 'Ready', hint: 'Clear enough to claim' },
  { status: 'claimed', label: 'Claimed', hint: 'Owned, not started' },
  { status: 'working', label: 'Working', hint: 'Active local work' },
  { status: 'blocked', label: 'Needs help', hint: 'A team decision is needed' },
  { status: 'review', label: 'Review', hint: 'Ready for another set of eyes' },
  { status: 'done', label: 'Done', hint: 'Verified and complete' }
]

function pathForProject(project: { worktree?: string; directory?: string; path?: string }): string {
  return project.worktree ?? project.directory ?? project.path ?? ''
}

function projectName(path: string): string {
  return path.replace(/\/+$/, '').split(/[\\/]/).pop() || path
}

function timeAgo(timestamp: number): string {
  const elapsed = Date.now() - timestamp
  if (elapsed < 60_000) return 'now'
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`
  return `${Math.floor(elapsed / 86_400_000)}d ago`
}

function setTeam(snapshot: TeamSnapshot): void {
  appStore.setState({ team: snapshot, lastError: null })
}

function report(error: unknown): void {
  appStore.setState({ lastError: errorSummary(error) })
}

interface TaskDraft {
  title: string
  summary: string
  acceptance: string
  projectHint: string
  status: 'proposed' | 'ready'
}

const EMPTY_TASK: TaskDraft = { title: '', summary: '', acceptance: '', projectHint: '', status: 'proposed' }

function draftInput(draft: TaskDraft): TeamTaskInput {
  return {
    title: draft.title,
    summary: draft.summary,
    acceptanceCriteria: draft.acceptance.split('\n').map((item) => item.replace(/^[-*]\s*/, '').trim()).filter(Boolean),
    projectHint: draft.projectHint,
    status: draft.status
  }
}

function SetupView({ identityName }: { identityName: string }): React.JSX.Element {
  const [mode, setMode] = useState<'choose' | 'host' | 'join'>('choose')
  const [name, setName] = useState('Vibe Code Friday')
  const [brief, setBrief] = useState('')
  const [memberName, setMemberName] = useState(identityName)
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)

  const run = async (action: () => Promise<TeamSnapshot>): Promise<void> => {
    setBusy(true)
    try { setTeam(await action()) } catch (error) { report(error) } finally { setBusy(false) }
  }

  return (
    <div className="team-empty-state">
      <div className="team-empty-icon"><TeamIcon size={28} /></div>
      <h1>Work together without sharing your private agent chats</h1>
      <p>Host a lightweight task board or connect to a teammate's R.A.L.F. Each developer claims work and runs it locally with their own backend, credentials, and worktrees.</p>
      {mode === 'choose' ? <div className="team-setup-actions">
        <button className="btn-allow" onClick={() => setMode('host')}>Host a team board</button>
        <button className="btn-secondary" onClick={() => setMode('join')}>Join a teammate</button>
      </div> : null}
      {mode === 'host' ? <div className="team-setup-card">
        <label>Your name<input value={memberName} onChange={(event) => setMemberName(event.target.value)} /></label>
        <label>Team or session name<input value={name} onChange={(event) => setName(event.target.value)} autoFocus /></label>
        <label>Shared brief<textarea value={brief} onChange={(event) => setBrief(event.target.value)} placeholder="What are we trying to accomplish? Include constraints and decisions everyone needs." /></label>
        <div className="team-form-actions"><button className="btn-ghost" onClick={() => setMode('choose')}>Back</button><button className="btn-allow" disabled={busy || !name.trim() || !memberName.trim()} onClick={() => void run(() => OpenCode.createTeam(name, brief, memberName))}>{busy ? 'Creating…' : 'Create board'}</button></div>
      </div> : null}
      {mode === 'join' ? <div className="team-setup-card">
        <label>Your name<input value={memberName} onChange={(event) => setMemberName(event.target.value)} /></label>
        <label>Host address<input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="http://teammate.tailnet-name.ts.net" autoFocus /></label>
        <label>Team token<input value={token} onChange={(event) => setToken(event.target.value)} placeholder="Paste the team-only token" /></label>
        <div className="team-form-actions"><button className="btn-ghost" onClick={() => setMode('choose')}>Back</button><button className="btn-allow" disabled={busy || !url.trim() || !token.trim() || !memberName.trim()} onClick={() => void run(() => OpenCode.connectTeam(url, token, memberName))}>{busy ? 'Connecting…' : 'Join board'}</button></div>
      </div> : null}
      <small className="team-lab-note">Experimental: peer connections use your existing Tailscale remote-access server. The team token is restricted to board operations.</small>
    </div>
  )
}

function TaskCard({ task, me, onOpen, onClaim, onStart, onMove }: {
  task: TeamTask
  me: string
  onOpen: () => void
  onClaim: (release?: boolean) => void
  onStart: () => void
  onMove: (status: TeamTaskStatus) => void
}): React.JSX.Element {
  const mine = task.assigneeId === me
  const canClaim = !task.assigneeId && (task.status === 'proposed' || task.status === 'ready')
  const canStart = mine && (task.status === 'claimed' || task.status === 'ready') && !task.execution
  return (
    <article
      className={`team-task-card ${mine ? 'mine' : ''}`}
      draggable
      onDragStart={(event) => event.dataTransfer.setData('application/x-ralf-team-task', task.id)}
      onClick={onOpen}
    >
      <div className="team-task-top"><span className="team-task-title">{task.title}</span><span className="team-task-age">{timeAgo(task.updatedAt)}</span></div>
      {task.summary ? <p>{task.summary}</p> : null}
      {task.projectHint ? <span className="team-project-hint">{task.projectHint}</span> : null}
      {task.execution ? <div className={`team-execution ${task.execution.state}`}><span className="team-execution-dot" />{BACKEND_SHORT_LABELS[task.execution.backendId]} · {task.execution.state.replace('-', ' ')}{task.execution.worktreeBranch ? ` · ${task.execution.worktreeBranch}` : ''}</div> : null}
      <div className="team-task-footer">
        <span className={`team-assignee ${mine ? 'self' : ''}`}>{task.assigneeName ?? 'Unclaimed'}</span>
        <span className="team-card-actions">
          {canClaim ? <button onClick={(event) => { event.stopPropagation(); onClaim() }}>Claim</button> : null}
          {mine && !task.execution ? <button onClick={(event) => { event.stopPropagation(); onClaim(true) }}>Release</button> : null}
          {canStart ? <button className="primary" onClick={(event) => { event.stopPropagation(); onStart() }}>Start</button> : null}
          {task.status === 'proposed' ? <button onClick={(event) => { event.stopPropagation(); onMove('ready') }}>Ready</button> : null}
        </span>
      </div>
    </article>
  )
}

function TaskEditor({ task, tasks, onClose, onSave, onDelete }: {
  task: TeamTask
  tasks: TeamTask[]
  onClose: () => void
  onSave: (patch: TeamTaskPatch) => Promise<void>
  onDelete: () => Promise<void>
}): React.JSX.Element {
  const [title, setTitle] = useState(task.title)
  const [summary, setSummary] = useState(task.summary)
  const [acceptance, setAcceptance] = useState(task.acceptanceCriteria.join('\n'))
  const [projectHint, setProjectHint] = useState(task.projectHint ?? '')
  const [status, setStatus] = useState(task.status)
  const [update, setUpdate] = useState('')
  const [busy, setBusy] = useState(false)
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <div className="modal team-task-modal">
      <h3>Edit task</h3>
      <div className="body team-task-form">
        <label>Title<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label>Details<textarea value={summary} onChange={(event) => setSummary(event.target.value)} /></label>
        <label>Acceptance criteria<textarea value={acceptance} onChange={(event) => setAcceptance(event.target.value)} placeholder="One item per line" /></label>
        <div className="team-form-row"><label>Status<select value={status} onChange={(event) => setStatus(event.target.value as TeamTaskStatus)}>{TEAM_TASK_STATUSES.map((item) => <option key={item} value={item}>{COLUMNS.find((column) => column.status === item)?.label ?? item}</option>)}</select></label><label>Project hint<input value={projectHint} onChange={(event) => setProjectHint(event.target.value)} /></label></div>
        <label>Publish an update<textarea value={update} onChange={(event) => setUpdate(event.target.value)} placeholder="Only this update is shared—not your private transcript." /></label>
        {task.dependencies.length ? <div className="team-dependencies"><strong>Depends on</strong>{task.dependencies.map((id) => <span key={id}>{tasks.find((item) => item.id === id)?.title ?? 'Removed task'}</span>)}</div> : null}
        {task.updates.length ? <div className="team-update-list"><strong>Shared updates</strong>{task.updates.slice().reverse().map((item) => <div key={item.id}><span>{item.authorName} · {timeAgo(item.createdAt)}</span><p>{item.body}</p></div>)}</div> : null}
      </div>
      <div className="actions team-editor-actions"><button className="btn-danger team-delete" disabled={busy} onClick={() => { setBusy(true); void onDelete().finally(() => setBusy(false)) }}><TrashIcon size={13} /> Delete</button><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-allow" disabled={busy || !title.trim()} onClick={() => { setBusy(true); void onSave({ title, summary, acceptanceCriteria: acceptance.split('\n'), projectHint, status, publicUpdate: update }).finally(() => setBusy(false)) }}>{busy ? 'Saving…' : 'Save'}</button></div>
    </div>
  </div>
}

function StartTaskModal({ task, onClose, onStarted }: { task: TeamTask; onClose: () => void; onStarted: (threadId: string, projectPath: string) => Promise<void> }): React.JSX.Element {
  const projects = useStore(appStore, (state) => state.projects)
  const currentPath = useStore(appStore, (state) => state.projectPath)
  const backends = useStore(appStore, (state) => state.backends)
  const projectPaths = useMemo(() => [...new Set([currentPath, ...projects.map(pathForProject)].filter((path) => path && path !== '/'))], [projects, currentPath])
  const [projectPath, setProjectPath] = useState(projectPaths[0] ?? '')
  const [backendId, setBackendId] = useState<BackendId>(backends.find((item) => item.available)?.id ?? 'opencode')
  const [worktree, setWorktree] = useState(true)
  const [busy, setBusy] = useState(false)
  const team = appStore.getState().team
  const start = async (): Promise<void> => {
    if (!team?.board) return
    setBusy(true)
    try {
      const result = await OpenCode.startTeamTask({ boardId: team.board.id, taskId: task.id, backendId, projectPath, worktree })
      setTeam(result.snapshot)
      await onStarted(result.threadId, projectPath)
      onClose()
    } catch (error) { report(error) } finally { setBusy(false) }
  }
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><div className="modal team-start-modal"><h3>Start “{task.title}”</h3><div className="body team-task-form"><label>Local project<select value={projectPath} onChange={(event) => setProjectPath(event.target.value)}>{projectPaths.map((path) => <option key={path} value={path}>{projectName(path)} — {path}</option>)}</select></label><label>Backend<select value={backendId} onChange={(event) => setBackendId(event.target.value as BackendId)}>{backends.filter((item) => item.available).map((backend) => <option key={backend.id} value={backend.id}>{backend.label}</option>)}</select></label><label className="team-worktree-toggle"><input type="checkbox" checked={worktree} onChange={(event) => setWorktree(event.target.checked)} /> Create an isolated Git worktree</label><p className="team-private-note">R.A.L.F. sends the shared brief and task to a new local thread. Your conversation and machine activity remain private.</p></div><div className="actions"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-allow" disabled={busy || !projectPath} onClick={() => void start()}>{busy ? 'Starting…' : 'Claim and start'}</button></div></div></div>
}

function PlanBoardModal({ boardId, onClose, onStarted }: { boardId: string; onClose: () => void; onStarted: (threadId: string, projectPath: string) => Promise<void> }): React.JSX.Element {
  const projects = useStore(appStore, (state) => state.projects)
  const currentPath = useStore(appStore, (state) => state.projectPath)
  const backends = useStore(appStore, (state) => state.backends)
  const projectPaths = useMemo(() => [...new Set([currentPath, ...projects.map(pathForProject)].filter((path) => path && path !== '/'))], [projects, currentPath])
  const [projectPath, setProjectPath] = useState(projectPaths[0] ?? '')
  const [backendId, setBackendId] = useState<BackendId>(backends.find((item) => item.available)?.id ?? 'opencode')
  const [busy, setBusy] = useState(false)
  const start = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await OpenCode.startTeamPlanning({ boardId, backendId, projectPath })
      setTeam(result.snapshot)
      await onStarted(result.threadId, projectPath)
      onClose()
    } catch (error) { report(error) } finally { setBusy(false) }
  }
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><div className="modal team-start-modal"><h3>Plan with an agent</h3><div className="body team-task-form"><p className="team-private-note">The agent receives the shared brief and can propose cards after discussing the breakdown with you. This planning conversation remains local.</p><label>Local project<select value={projectPath} onChange={(event) => setProjectPath(event.target.value)}>{projectPaths.map((path) => <option key={path} value={path}>{projectName(path)} — {path}</option>)}</select></label><label>Backend<select value={backendId} onChange={(event) => setBackendId(event.target.value as BackendId)}>{backends.filter((item) => item.available).map((backend) => <option key={backend.id} value={backend.id}>{backend.label}</option>)}</select></label></div><div className="actions"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-allow" disabled={busy || !projectPath} onClick={() => void start()}>{busy ? 'Starting…' : 'Start planning'}</button></div></div></div>
}

export function TeamBoardPage(): React.JSX.Element {
  const team = useStore(appStore, (state) => state.team)
  const settingsOpen = useStore(appStore, (state) => state.settingsOpen)
  const [loading, setLoading] = useState(!team)
  const [newTask, setNewTask] = useState(false)
  const [draft, setDraft] = useState<TaskDraft>(EMPTY_TASK)
  const [editing, setEditing] = useState<TeamTask | null>(null)
  const [starting, setStarting] = useState<TeamTask | null>(null)
  const [planning, setPlanning] = useState(false)
  const [brief, setBrief] = useState('')
  const [editingBrief, setEditingBrief] = useState(false)
  const [mobile, setMobile] = useState<MobileAccessStatus | null>(null)
  const [accessToken, setAccessToken] = useState('')
  const [copied, setCopied] = useState('')

  useEffect(() => {
    void refreshTeamBoard().finally(() => setLoading(false))
    const timer = window.setInterval(() => void refreshTeamBoard(), 4_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => { setBrief(team?.board?.brief ?? '') }, [team?.board?.brief])

  useEffect(() => {
    if (team?.mode !== 'host' || !team.board) return
    void Promise.all([OpenCode.mobileStatus(), OpenCode.teamAccess()]).then(([status, access]) => {
      setMobile(status)
      setAccessToken(access.token)
    }).catch(() => {})
  }, [team?.mode, team?.board?.id, settingsOpen])

  const mutate = async (action: () => Promise<TeamSnapshot>): Promise<void> => {
    try { setTeam(await action()) } catch (error) { report(error); void refreshTeamBoard() }
  }

  if (loading) return <div className="team-loading">Loading Team Board…</div>
  if (!team?.board) return <div className="team-page"><SetupView identityName={team?.identity.name ?? 'Developer'} /></div>

  const board = team.board
  const me = team.identity.id
  const connected = team.mode === 'host' || team.connection?.connected === true
  const shareUrl = mobile?.tailscaleUrl ?? mobile?.url ?? ''
  const copy = async (value: string, key: string): Promise<void> => {
    await navigator.clipboard.writeText(value)
    setCopied(key)
    window.setTimeout(() => setCopied(''), 1_500)
  }
  const openStarted = async (threadId: string, projectPath: string): Promise<void> => {
    await openProject(projectPath)
    await refreshSessions()
    selectSession(threadId)
  }
  const closeOrLeave = (): void => {
    if (team.mode === 'peer') {
      void mutate(() => OpenCode.disconnectTeam())
      return
    }
    appStore.setState({
      confirm: {
        title: 'Close this team board?',
        message: 'Teammates will disconnect and the shared board will be removed from this host. Local threads and worktrees are kept.',
        confirmLabel: 'Close board',
        destructive: true,
        action: () => { void mutate(() => OpenCode.closeTeam()) }
      }
    })
  }

  return <div className="team-page">
    <header className="team-header">
      <div><div className="team-eyebrow"><span className={`team-live-dot ${connected ? '' : 'offline'}`} />{team.mode === 'host' ? 'Hosting' : connected ? 'Connected' : 'Offline copy'} · Experimental</div><h1>{board.name}</h1><p>{board.tasks.length} tasks · {board.members.length} people</p></div>
      <div className="team-header-actions"><button className="btn-secondary" disabled={!connected} onClick={() => setPlanning(true)}>Plan with agent</button><button className="btn-secondary" disabled={!connected} onClick={() => setNewTask(true)}><PlusIcon size={14} /> Add task</button><button className="btn-ghost" onClick={closeOrLeave}>{team.mode === 'host' ? 'Close board' : 'Leave board'}</button></div>
    </header>

    <section className="team-context-row">
      <div className="team-brief-card">
        <div className="team-section-title"><span>Shared brief</span>{editingBrief ? <span><button onClick={() => { setBrief(board.brief); setEditingBrief(false) }}>Cancel</button><button className="primary" onClick={() => void mutate(() => OpenCode.updateTeamBoard(board.id, { brief })).then(() => setEditingBrief(false))}>Save</button></span> : <button onClick={() => setEditingBrief(true)}>Edit</button>}</div>
        {editingBrief ? <textarea value={brief} onChange={(event) => setBrief(event.target.value)} autoFocus /> : <p>{board.brief || 'No shared brief yet. Add the objective, constraints, and decisions everyone needs.'}</p>}
      </div>
      <div className="team-people-card"><div className="team-section-title"><span>People</span></div><div className="team-member-list">{board.members.map((member) => <div className={`team-member ${member.id === me ? 'self' : ''}`} key={member.id}><span>{member.name.slice(0, 1).toUpperCase()}</span><div><strong>{member.name}{member.id === me ? ' (you)' : ''}</strong><small>{member.deviceName ?? 'R.A.L.F. peer'} · {timeAgo(member.lastSeenAt)}</small></div></div>)}</div></div>
      {team.mode === 'host' ? <div className="team-share-card"><div className="team-section-title"><span>Invite</span></div>{mobile?.running ? <><p>Share these over your tailnet. The token only grants access to this board.</p><button onClick={() => void copy(shareUrl, 'url')}><span>{shareUrl}</span><CopyIcon size={13} />{copied === 'url' ? 'Copied' : 'Copy'}</button><button onClick={() => void copy(accessToken, 'token')}><span className="team-token">{accessToken}</span><CopyIcon size={13} />{copied === 'token' ? 'Copied' : 'Copy token'}</button></> : <><p>Turn on Mobile & Tailscale access in Settings to invite another R.A.L.F.</p><button onClick={() => appStore.setState({ settingsOpen: true })}>Open Settings</button></>}</div> : null}
    </section>

    <div className="team-board" aria-label="Team task board">{COLUMNS.map((column) => {
      const tasks = board.tasks.filter((task) => task.status === column.status)
      return <section className="team-column" key={column.status} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { const taskId = event.dataTransfer.getData('application/x-ralf-team-task'); if (taskId) void mutate(() => OpenCode.updateTeamTask(board.id, taskId, { status: column.status })) }}><header><div><strong>{column.label}</strong><small>{column.hint}</small></div><span>{tasks.length}</span></header><div className="team-column-list">{tasks.map((task) => <TaskCard key={task.id} task={task} me={me} onOpen={() => setEditing(task)} onClaim={(release) => void mutate(() => OpenCode.claimTeamTask(board.id, task.id, Boolean(release)))} onStart={() => setStarting(task)} onMove={(status) => void mutate(() => OpenCode.updateTeamTask(board.id, task.id, { status }))} />)}{tasks.length === 0 ? <div className="team-column-empty">Drop tasks here</div> : null}</div></section>
    })}</div>

    {newTask ? <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setNewTask(false) }}><div className="modal team-task-modal"><h3>Add a task</h3><div className="body team-task-form"><label>Title<input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} autoFocus /></label><label>Details<textarea value={draft.summary} onChange={(event) => setDraft({ ...draft, summary: event.target.value })} /></label><label>Acceptance criteria<textarea value={draft.acceptance} onChange={(event) => setDraft({ ...draft, acceptance: event.target.value })} placeholder="One item per line" /></label><div className="team-form-row"><label>Initial state<select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as 'proposed' | 'ready' })}><option value="proposed">Proposed</option><option value="ready">Ready to claim</option></select></label><label>Project hint<input value={draft.projectHint} onChange={(event) => setDraft({ ...draft, projectHint: event.target.value })} placeholder="ralf, api, docs…" /></label></div></div><div className="actions"><button className="btn-ghost" onClick={() => setNewTask(false)}>Cancel</button><button className="btn-allow" disabled={!draft.title.trim()} onClick={() => void mutate(() => OpenCode.createTeamTask(board.id, draftInput(draft))).then(() => { setDraft(EMPTY_TASK); setNewTask(false) })}>Add task</button></div></div></div> : null}
    {editing ? <TaskEditor task={editing} tasks={board.tasks} onClose={() => setEditing(null)} onSave={async (patch) => { await mutate(() => OpenCode.updateTeamTask(board.id, editing.id, patch, editing.revision)); setEditing(null) }} onDelete={async () => { await mutate(() => OpenCode.deleteTeamTask(board.id, editing.id)); setEditing(null) }} /> : null}
    {starting ? <StartTaskModal task={starting} onClose={() => setStarting(null)} onStarted={openStarted} /> : null}
    {planning ? <PlanBoardModal boardId={board.id} onClose={() => setPlanning(false)} onStarted={openStarted} /> : null}
  </div>
}
