import React, { useEffect, useRef, useState } from 'react'
import { useStore, appStore } from '../state/AppState'
import type { SessionInfo } from '@shared/opencode'
import {
  archiveAllInPath,
  deleteSession,
  forkSession,
  newChatInProject,
  newSession,
  openCommitDialog,
  openProject,
  openProjectFolder,
  selectSession,
  sessionMetaFor,
  toggleArchive
} from '../lib/actions'
import { ChatIcon, ChevronIcon, FolderIcon, GearIcon, PlusIcon } from './icons'

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
      <button className="section-add" onClick={onAdd} title={addTitle}>
        <PlusIcon size={12} />
      </button>
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

function SessionRow({ session, active, onCtx }: { session: SessionInfo; active: boolean; onCtx: (e: React.MouseEvent, s: SessionInfo) => void }): React.JSX.Element {
  const meta = sessionMetaFor(session.id)
  const busy = useStore(appStore, (s) => Boolean(s.sessionBusy[session.id]))
  const compacting = useStore(appStore, (s) => Boolean(s.compacting[session.id]))
  return (
    <div
      className={`item sub ${active ? 'active' : ''}`}
      onClick={() => selectSession(session.id)}
      onContextMenu={(e) => onCtx(e, session)}
      title={meta?.forkedFrom ? `Forked from ${meta.forkedFrom.sessionId.slice(0, 12)}` : meta?.kind === 'side' ? 'Side chat' : session.title}
    >
      <span className="icon">
        <ChatIcon size={14} />
      </span>
      <span className="name">{session.title || 'Untitled'}</span>
      {meta?.kind === 'fork' ? <span className="badge fork">fork</span> : null}
      {meta?.kind === 'side' ? <span className="badge side">side</span> : null}
      {compacting ? <span className="badge compacting">compacting</span> : null}
      {busy && !compacting ? <span className="spinner-sm" /> : null}
      <span className="meta">{timeAgo(session.time?.updated)}</span>
    </div>
  )
}

export function Sidebar(): React.JSX.Element {
  const sessions = useStore(appStore, (s) => s.sessions)
  const projects = useStore(appStore, (s) => s.projects)
  const activeSessionId = useStore(appStore, (s) => s.activeSessionId)
  const projectPath = useStore(appStore, (s) => s.projectPath)
  const archived = useStore(appStore, (s) => s.archived)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [ctx, setCtx] = useState<CtxMenu | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const projectsRef = useRef<HTMLDivElement>(null)
  const [projectsH, setProjectsH] = useState<number | null>(() => {
    try {
      const saved = Number(localStorage.getItem('ralf.sidebarProjectsH'))
      return Number.isFinite(saved) && saved > 0 ? saved : null
    } catch {
      return null
    }
  })

  const archivedSet = new Set(archived)
  const visibleSessions = sessions.filter((s) => !archivedSet.has(s.id) && !s.parentID)
  const archivedSessions = sessions.filter((s) => archivedSet.has(s.id))

  const sessionsByPath = new Map<string, SessionInfo[]>()
  for (const session of visibleSessions) {
    const raw = session.directory || session.path || ''
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
    if (activePath && !expanded.has(activePath)) {
      setExpanded((prev) => new Set(prev).add(activePath))
    }
  }, [activePath])

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
    const next = new Set(expanded)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    setExpanded(next)
    if (path !== activePath) void openProject(path)
  }

  const onDividerDown = (e: React.MouseEvent): void => {
    e.preventDefault()
    const startY = e.clientY
    const startH = projectsH ?? projectsRef.current?.getBoundingClientRect().height ?? 200
    const onMove = (ev: MouseEvent): void => {
      const h = Math.min(Math.max(60, startH + (ev.clientY - startY)), 480)
      setProjectsH(h)
      try {
        localStorage.setItem('ralf.sidebarProjectsH', String(h))
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

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="logo">
          <img className="logo-mark" src="./icon.png" alt="Ralf" />
          <span>Ralf</span>
        </div>
      </div>
      <button className="btn-new" onClick={() => void newSession()}>
        <PlusIcon size={15} />
        <span>New chat</span>
      </button>

      <div className="sidebar-section projects" style={projectsH ? { height: projectsH } : undefined}>
        <SectionHeader label="Projects" onAdd={() => void openProjectFolder()} addTitle="Add a project folder" />
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
          const isExpanded = expanded.has(path)
          const pathSessions = sessionsByPath.get(path) ?? []
          return (
            <div key={path}>
              <div
                className={`item dir ${isActive ? 'active' : ''}`}
                onClick={() => open(path)}
                onContextMenu={(e) => onProjectCtx(e, path)}
                title={path}
              >
                <span className="icon" style={{ transform: isExpanded ? 'rotate(90deg)' : undefined, transition: 'transform 0.12s ease' }}>
                  <ChevronIcon size={14} />
                </span>
                <span className="icon">
                  <FolderIcon size={15} />
                </span>
                <span className="name">{projectName(path)}</span>
                <span className="meta">{pathSessions.length || ''}</span>
              </div>
              {isExpanded &&
                (pathSessions.length > 0 ? (
                  pathSessions.map((session) => (
                    <SessionRow key={session.id} session={session} active={session.id === activeSessionId} onCtx={onSessionCtx} />
                  ))
                ) : (
                  <div style={{ padding: '4px 8px 4px 46px', fontSize: 12, color: 'var(--text-faint)' }}>
                    {isActive ? 'No chats yet' : 'Open project to load chats'}
                  </div>
                ))}
            </div>
          )
        })}
        {projectPaths.length === 0 && (
          <div style={{ padding: '4px 8px', fontSize: 12, color: 'var(--text-faint)' }}>No projects yet</div>
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

      <SectionHeader label="Chats" onAdd={() => void newSession()} addTitle="New chat" />
      <div className="list sidebar-section-chats">
        {looseChats.map((session) => (
          <SessionRow key={session.id} session={session} active={session.id === activeSessionId} onCtx={onSessionCtx} />
        ))}
        {looseChats.length === 0 && (
          <div style={{ padding: '4px 8px', fontSize: 12, color: 'var(--text-faint)' }}>No chats yet</div>
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
          <span style={{ fontSize: 11 }}>{projectName(activePath) || ''}</span>
          <button className="footer-gear" onClick={() => appStore.setState({ settingsOpen: true })} title="Settings">
            <GearIcon size={18} />
          </button>
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
              {menuItem('Open in Finder', () => void window.ralf.openPath(ctx.project!))}
            </>
          ) : ctx.session ? (
            <>
              {menuItem('Open', () => selectSession(ctx.session!.id))}
              {menuItem('Rename…', () => appStore.setState({ renameTarget: ctx.session!.id }))}
              {menuItem('Fork', () => void forkSession(ctx.session!.id))}
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
                    title: 'Delete chat?',
                    message: 'This permanently deletes the chat and its history. This cannot be undone.',
                    confirmLabel: 'Delete',
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
  )
}
