import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useStore, appStore } from '../state/AppState'
import type { SessionInfo } from '@shared/opencode'
import type { OwnedResource } from '../lib/workspaces'
import { TAB_DRAG_TYPE, resourcesByThread } from '../lib/workspaces'
import {
  archiveAllInPath,
  cloneThreadToBackend,
  deleteSession,
  forkSession,
  forkSessionIntoWorktree,
  newGlobalChat,
  newChatInProject,
  openCommitDialog,
  openProject,
  openProjectFolder,
  removeSessionWorktree,
  revealWorkspaceTab,
  selectSession,
  sessionMetaFor,
  showPage,
  toggleArchive
} from '../lib/actions'
import { ChatIcon, ChevronIcon, FilesIcon, FolderIcon, GearIcon, GlobeIcon, PanelIcon, PlusIcon, ReviewIcon, TerminalIcon } from './icons'
import { BACKEND_SHORT_LABELS } from '../lib/backend-labels'
import { IconButton } from './ui'

/** Threads shown per project before "Show N more". */
const THREADS_PER_PROJECT = 20

interface CtxMenu {
  x: number
  y: number
  project?: string
  session?: SessionInfo
}

function SectionHeader({ label, onAdd, addTitle }: { label: string; onAdd: () => void; addTitle: string }): React.JSX.Element {
  return (
    <div className="section-head">
      <span className="section-label">{label}</span>
      <IconButton size="small" className="section-add" onClick={onAdd} label={addTitle}>
        <PlusIcon size={12} />
      </IconButton>
    </div>
  )
}

function timeAgo(ts?: number): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 60_000) return 'now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`
  return `${Math.floor(diff / 86_400_000)}d`
}

function projectName(path: string): string {
  const parts = path.replace(/\/+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || path
}

function SessionRow({
  session,
  active,
  onCtx,
  resourceCount = 0,
  expanded = false,
  onToggle
}: {
  session: SessionInfo
  active: boolean
  onCtx: (e: React.MouseEvent, s: SessionInfo) => void
  resourceCount?: number
  expanded?: boolean
  onToggle?: () => void
}): React.JSX.Element {
  const meta = sessionMetaFor(session.id)
  const busy = useStore(appStore, (s) => Boolean(s.sessionBusy[session.id]))
  const compacting = useStore(appStore, (s) => Boolean(s.compacting[session.id]))
  const preferredModel = useStore(appStore, (s) => s.modelsBySession[session.id])
  const model = preferredModel ?? session.model?.id
  const backend = BACKEND_SHORT_LABELS[session.backendId ?? 'opencode']
  const details = [
    backend,
    model?.split('/').pop(),
    session.worktree?.status === 'active' ? session.worktree.branch : undefined,
    session.worktree?.status === 'removed' ? 'Worktree cleaned' : undefined,
    meta?.kind === 'fork' ? 'Fork' : undefined,
    meta?.kind === 'side' ? 'Side chat' : undefined,
    compacting ? 'Compacting' : busy ? 'Working' : undefined
  ].filter(Boolean)
  return (
    <div
      className={`item sub session-row ${active ? 'active' : ''}`}
      onClick={() => selectSession(session.id)}
      onContextMenu={(e) => onCtx(e, session)}
      title={meta?.forkedFrom ? `Forked from ${meta.forkedFrom.sessionId.slice(0, 12)}` : meta?.kind === 'side' ? 'Side chat' : session.title}
    >
      <span
        className={`session-caret ${expanded ? 'open' : ''} ${resourceCount ? '' : 'empty'}`}
        onClick={(event) => {
          if (!resourceCount) return
          event.stopPropagation()
          onToggle?.()
        }}
        title={resourceCount ? `${resourceCount} resource${resourceCount === 1 ? '' : 's'}` : undefined}
      >
        {resourceCount ? <ChevronIcon size={10} /> : null}
      </span>
      <span className={`session-state ${compacting ? 'compacting' : busy ? 'busy' : 'idle'}`} title={compacting ? 'Compacting' : busy ? 'Agent is working' : 'Idle'}>
        <span />
      </span>
      <span className="session-copy">
        <span className="name">{session.title || 'Untitled'}</span>
        <span className="session-details">{details.join(' · ')}</span>
      </span>
      <span className="meta">{timeAgo(session.time?.updated)}</span>
    </div>
  )
}

const RESOURCE_LABELS: Record<string, string> = {
  terminal: 'Terminal',
  review: 'Review',
  files: 'Files',
  browser: 'Browser'
}

const RESOURCE_ICONS: Record<string, (props: { size?: number }) => React.JSX.Element> = {
  terminal: TerminalIcon,
  review: ReviewIcon,
  files: FilesIcon,
  browser: GlobeIcon
}

function ResourceRow({ resource }: { resource: OwnedResource }): React.JSX.Element {
  const Icon = RESOURCE_ICONS[resource.kind] ?? ChatIcon
  return (
    <div
      className="item resource-row"
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData(TAB_DRAG_TYPE, resource.id)
      }}
      onClick={() => revealWorkspaceTab(resource.viewId, resource.groupId, resource.id)}
      title={`${RESOURCE_LABELS[resource.kind] ?? resource.kind} — ${resource.contextLabel ?? resource.contextPath ?? ''} — drag into a view to move it`}
    >
      <span className="icon"><Icon size={13} /></span>
      <span className="name">{RESOURCE_LABELS[resource.kind] ?? resource.kind}</span>
      <span className="resource-where">{resource.viewName}</span>
    </div>
  )
}

export function Sidebar(): React.JSX.Element {
  const sessions = useStore(appStore, (s) => s.sessions)
  const projects = useStore(appStore, (s) => s.projects)
  const activeSessionId = useStore(appStore, (s) => s.activeSessionId)
  const projectPath = useStore(appStore, (s) => s.projectPath)
  const activePage = useStore(appStore, (s) => s.activePage)
  const archived = useStore(appStore, (s) => s.archived)
  const backends = useStore(appStore, (s) => s.backends)
  const workspace = useStore(appStore, (s) => s.projectWorkspace)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [openThreads, setOpenThreads] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')

  // Which resources belong to which thread, wherever they were dragged. Derived
  // from the view trees rather than stored on the tab: the tree already records
  // placement, and a second copy would drift the moment a resource moves.
  //
  // Only the loaded project's workspace is in state, so threads in other
  // projects list no resources. That matches what the user can reach: their
  // views are not on screen, so a row pointing into them would go nowhere.
  const resources = useMemo(
    () => resourcesByThread(workspace?.views ?? []),
    [workspace]
  )
  const [ctx, setCtx] = useState<CtxMenu | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const projectsRef = useRef<HTMLDivElement>(null)
  const [sidebarHidden, setSidebarHidden] = useState(() => {
    try { return localStorage.getItem('boss.sidebarHidden') === 'true' } catch { return false }
  })
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem('boss.sidebarWidth'))
      return Number.isFinite(saved) && saved >= 210 ? saved : 268
    } catch {
      return 268
    }
  })
  const [projectsH, setProjectsH] = useState<number | null>(() => {
    try {
      const saved = Number(localStorage.getItem('boss.sidebarProjectsH'))
      return Number.isFinite(saved) && saved > 0 ? saved : null
    } catch {
      return null
    }
  })

  const archivedSet = new Set(archived)
  const query = filter.trim().toLowerCase()
  // Matching on the project too, so "cage" finds every thread in that project
  // without expanding it — the point of filtering is not to drill.
  const matches = (session: SessionInfo): boolean => {
    if (!query) return true
    const where = session.projectPath ?? session.directory ?? session.path ?? ''
    return `${session.title ?? ''} ${where}`.toLowerCase().includes(query)
  }
  const visibleSessions = sessions.filter((s) => !archivedSet.has(s.id) && !s.parentID && matches(s))
  const archivedSessions = sessions.filter((s) => archivedSet.has(s.id) && matches(s))

  const sessionsByPath = new Map<string, SessionInfo[]>()
  for (const session of visibleSessions) {
    const raw = session.projectPath ?? session.directory ?? session.path ?? ''
    const key = raw === '/' ? '' : raw
    const list = sessionsByPath.get(key) ?? []
    list.push(session)
    sessionsByPath.set(key, list)
  }
  const looseChats = sessionsByPath.get('') ?? []
  const projectPaths = Array.from(
    new Set(
      [
        ...projects
          .filter((p) => p.id !== 'global')
          .map((p) => p.worktree ?? p.directory ?? p.path ?? '')
          .filter((p) => p && p !== '/'),
        ...sessionsByPath.keys()
      ].filter(Boolean)
    )
  )
  const activePath = projectPath

  useEffect(() => {
    if (!ctx) return
    const close = (): void => setCtx(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    const onDoc = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) close()
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [ctx])

  const open = (path: string): void => {
    if (path !== activePath) void openProject(path)
    else showPage('project')
  }

  const onDividerDown = (e: React.MouseEvent): void => {
    e.preventDefault()
    const startY = e.clientY
    const startH = projectsH ?? projectsRef.current?.getBoundingClientRect().height ?? 200
    const onMove = (ev: MouseEvent): void => {
      const h = Math.min(Math.max(60, startH + (ev.clientY - startY)), 480)
      setProjectsH(h)
      try {
        localStorage.setItem('boss.sidebarProjectsH', String(h))
      } catch {
        /* ignore */
      }
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = ''
    }
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const setHidden = (hidden: boolean): void => {
    setSidebarHidden(hidden)
    try { localStorage.setItem('boss.sidebarHidden', String(hidden)) } catch { /* ignore */ }
  }

  const onWidthDividerDown = (event: React.MouseEvent): void => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = sidebarWidth
    const onMove = (next: MouseEvent): void => {
      const width = Math.min(480, Math.max(210, startWidth + next.clientX - startX))
      setSidebarWidth(width)
      try { localStorage.setItem('boss.sidebarWidth', String(width)) } catch { /* ignore */ }
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = ''
    }
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const onProjectCtx = (e: React.MouseEvent, path: string): void => {
    e.preventDefault()
    e.stopPropagation()
    setCtx({ x: e.clientX, y: e.clientY, project: path })
  }

  const onSessionCtx = (e: React.MouseEvent, session: SessionInfo): void => {
    e.preventDefault()
    e.stopPropagation()
    setCtx({ x: e.clientX, y: e.clientY, session })
  }

  // A thread and the resources it owns. Filtering opens every thread, for the
  // same reason it opens every project: search replaces drilling.
  const threadRow = (session: SessionInfo): React.JSX.Element => {
    const owned = resources.get(session.id) ?? []
    const isOpen = openThreads.has(session.id) || Boolean(query)
    return (
      <React.Fragment key={session.id}>
        <SessionRow
          session={session}
          active={session.id === activeSessionId}
          onCtx={onSessionCtx}
          resourceCount={owned.length}
          expanded={isOpen}
          onToggle={() =>
            setOpenThreads((prev) => {
              const next = new Set(prev)
              if (next.has(session.id)) next.delete(session.id)
              else next.add(session.id)
              return next
            })
          }
        />
        {isOpen ? owned.map((resource) => <ResourceRow key={resource.id} resource={resource} />) : null}
      </React.Fragment>
    )
  }

  const menuItem = (label: string, fn: () => void): React.JSX.Element => (
    <button
      className="ctx-item"
      onClick={() => {
        setCtx(null)
        fn()
      }}
    >
      {label}
    </button>
  )

  if (sidebarHidden) {
    return (
      <div className="sidebar-collapsed">
        <IconButton label="Show sidebar" onClick={() => setHidden(false)}><PanelIcon size={15} /></IconButton>
      </div>
    )
  }

  return (
    <>
    <aside className="sidebar" style={{ width: sidebarWidth, flexBasis: sidebarWidth }}>
      <div className="sidebar-head">
        <div className="logo">
          <span>BOSS</span>
        </div>
        <IconButton className="sidebar-collapse" label="Hide sidebar" onClick={() => setHidden(true)}>
          <PanelIcon size={14} />
        </IconButton>
      </div>
      <nav className="sidebar-primary" aria-label="Primary navigation">
        <button className={`sidebar-primary-item ${activePage === 'command-center' ? 'active' : ''}`} onClick={() => showPage('command-center')}>
          <PanelIcon size={15} /><span>Command Center</span>
        </button>
        <button className={`sidebar-primary-item ${activePage === 'automations' ? 'active' : ''}`} onClick={() => showPage('automations')}>
          <ReviewIcon size={15} /><span>Automations</span>
        </button>
        <button className={`sidebar-primary-item ${activePage === 'sites' ? 'active' : ''}`} onClick={() => showPage('sites')}>
          <GlobeIcon size={15} /><span>Sites</span>
        </button>
      </nav>
      <div className="sidebar-section-rule" />

      <div className="sidebar-section projects" style={projectsH ? { height: projectsH } : undefined}>
        <SectionHeader label="Projects" onAdd={() => void openProjectFolder()} addTitle="Add a project folder" />
        <div className="sidebar-filter">
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter threads"
            aria-label="Filter threads"
            spellCheck={false}
          />
          {filter ? (
            <button className="sidebar-filter-clear" onClick={() => setFilter('')} aria-label="Clear filter">×</button>
          ) : null}
        </div>
        <div
          className="list"
          ref={projectsRef}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            const dropped = e.dataTransfer?.files?.[0] as File & { path?: string } | undefined
            const path = dropped?.path
            if (path) void openProject(path)
          }}
        >
        {projectPaths.map((path) => {
          const isActive = path === activePath
          const pathSessions = sessionsByPath.get(path) ?? []
          // Threads are always listed; "expanded" now only lifts the per-project
          // cap, so a project with hundreds of threads cannot flood the sidebar.
          // While filtering, a project with matches opens itself: hunting
          // through collapsed folders is the thing search is meant to replace.
          const isExpanded = expanded.has(path) || Boolean(query)
          const shown = isExpanded ? pathSessions : pathSessions.slice(0, THREADS_PER_PROJECT)
          const hidden = pathSessions.length - shown.length
          return (
            <div key={path}>
              <div
                className={`item dir project-row ${isActive ? 'active' : ''}`}
                onClick={() => open(path)}
                onContextMenu={(e) => onProjectCtx(e, path)}
                title={path}
              >
                <span className="icon">
                  <FolderIcon size={15} />
                </span>
                <span className="project-row-copy">
                  <span className="name">{projectName(path)}</span>
                  {isActive ? <span className="project-row-path">{path}</span> : null}
                </span>
                <span className="meta">{pathSessions.length || ''}</span>
              </div>
              {shown.map(threadRow)}
              {hidden > 0 ? (
                <div
                  className="sidebar-load-more nested"
                  onClick={(e) => {
                    e.stopPropagation()
                    setExpanded((prev) => new Set(prev).add(path))
                  }}
                >
                  Show {hidden} more
                </div>
              ) : null}
              {pathSessions.length === 0 ? (
                <div className="sidebar-empty nested">No chats yet</div>
              ) : null}
            </div>
          )
        })}
        {projectPaths.length === 0 && (
          <div className="sidebar-empty">No projects yet</div>
        )}
        <div className="item" onClick={() => void openProjectFolder()}>
          <span className="icon">
            <FolderIcon size={15} />
          </span>
          <span className="name">Open folder…</span>
        </div>
      </div>
      </div>
      <div className="sidebar-divider" onMouseDown={onDividerDown} title="Drag to resize" />

      <SectionHeader label="Chats" onAdd={() => void newGlobalChat()} addTitle="New chat" />
      <div className="list sidebar-section-chats">
        {looseChats.map(threadRow)}
        {looseChats.length === 0 && (
          <div className="sidebar-empty">No chats yet</div>
        )}
      </div>

      {archivedSessions.length > 0 && (
        <>
          <div className="section-label">Archived</div>
          <div className="list">
            {archivedSessions.map((session) => (
              <div key={session.id} className="item sub" onContextMenu={(e) => onSessionCtx(e, session)} title={session.title || 'Untitled'}>
                <span className="icon">
                  <ChatIcon size={14} />
                </span>
                <span className="name" style={{ color: 'var(--text-faint)' }}>{session.title || 'Untitled'}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="footer">
        <span className="right" style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <IconButton size="small" className="footer-gear" onClick={() => appStore.setState({ settingsOpen: true })} label="Settings">
            <GearIcon size={18} />
          </IconButton>
        </span>
      </div>

      {ctx && (
        <div ref={menuRef} className="ctx-menu" style={{ left: Math.min(ctx.x, window.innerWidth - 220), top: ctx.y }}>
          {ctx.project ? (
            <>
              {menuItem('New chat here', () => void newChatInProject(ctx.project!))}
              {menuItem('Commit & push…', () => openCommitDialog(ctx.project!))}
              {menuItem('Archive all chats', () =>
                appStore.setState({
                  confirm: {
                    title: 'Archive all chats?',
                    message: `Archive all chats in this project? You can restore them later from the Archived section.`,
                    confirmLabel: 'Archive',
                    action: () => archiveAllInPath(ctx.project!)
                  }
                })
              )}
              {menuItem('Open in Finder', () => void window.boss.openPath(ctx.project!))}
            </>
          ) : ctx.session ? (
            <>
              {menuItem('Open', () => selectSession(ctx.session!.id))}
              {menuItem('Rename…', () => appStore.setState({ renameTarget: ctx.session!.id }))}
              {menuItem('Delegate…', () => appStore.setState({ delegateTarget: ctx.session!.id }))}
              {menuItem('Goal & budget…', () => appStore.setState({ policyTarget: ctx.session!.id }))}
              {menuItem('Fork', () => void forkSession(ctx.session!.id))}
              {ctx.session.projectId !== 'global' ? menuItem('Fork into worktree…', () =>
                appStore.setState({
                  confirm: {
                    title: 'Fork into a Git worktree?',
                    message: 'BOSS will create an isolated branch from this thread\'s current HEAD and continue the conversation there. The original thread remains unchanged.',
                    confirmLabel: 'Create worktree',
                    action: () => void forkSessionIntoWorktree(ctx.session!.id)
                  }
                })
              ) : null}
              {ctx.session.worktree?.status === 'active' ? menuItem('Remove worktree…', () =>
                appStore.setState({
                  confirm: {
                    title: 'Remove this worktree?',
                    message: `BOSS will remove the worktree folder for ${ctx.session!.worktree!.branch}. Git refuses if it contains uncommitted or untracked work; the branch and conversation will be kept.`,
                    confirmLabel: 'Remove worktree',
                    destructive: true,
                    action: () => void removeSessionWorktree(ctx.session!.id)
                  }
                })
              ) : null}
              {backends
                .filter((backend) => backend.available && backend.id !== (ctx.session!.backendId ?? 'opencode'))
                .map((backend) => (
                  <React.Fragment key={backend.id}>
                    {menuItem(`Continue in ${BACKEND_SHORT_LABELS[backend.id]}`, () =>
                      appStore.setState({
                        confirm: {
                          title: `Continue in ${BACKEND_SHORT_LABELS[backend.id]}?`,
                          message: 'BOSS will create a new thread with a bounded context handoff. The original thread remains unchanged.',
                          confirmLabel: `Continue in ${BACKEND_SHORT_LABELS[backend.id]}`,
                          action: () => void cloneThreadToBackend(ctx.session!.id, backend.id)
                        }
                      })
                    )}
                  </React.Fragment>
                ))}
              {archivedSet.has(ctx.session.id) ? (
                menuItem('Unarchive', () => toggleArchive(ctx.session!.id))
              ) : (
                menuItem('Archive', () =>
                  appStore.setState({
                    confirm: {
                      title: 'Archive chat?',
                      message: 'Archive this chat? You can restore it later from the Archived section.',
                      confirmLabel: 'Archive',
                      action: () => toggleArchive(ctx.session!.id)
                    }
                  })
                )
              )}
              {menuItem('Delete', () =>
                appStore.setState({
                  confirm: {
                    title: 'Remove thread?',
                    message: 'Remove this thread from BOSS? Some backends may retain their own native history.',
                    confirmLabel: 'Remove',
                    destructive: true,
                    action: () => void deleteSession(ctx.session!.id)
                  }
                })
              )}
              {menuItem('Copy ID', () => void navigator.clipboard.writeText(ctx.session!.id))}
            </>
          ) : null}
        </div>
      )}
    </aside>
    <div className="sidebar-width-divider" onMouseDown={onWidthDividerDown} title="Drag to resize sidebar" />
    </>
  )
}
