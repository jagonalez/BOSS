import React, { useState } from 'react'
import { useStore, appStore } from '../state/AppState'
import type { SessionInfo } from '@shared/opencode'
import { newSession, openProject, openProjectFolder, selectSession } from '../lib/actions'
import { ChatIcon, ChevronIcon, FolderIcon, PlusIcon } from './icons'

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
  const diff = Date.now() - ts * 1000
  if (diff < 60_000) return 'now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`
  return `${Math.floor(diff / 86_400_000)}d`
}

function projectName(path: string): string {
  const parts = path.replace(/\/+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || path
}

function SessionRow({ session, active }: { session: SessionInfo; active: boolean }): React.JSX.Element {
  return (
    <div className={`item sub ${active ? 'active' : ''}`} onClick={() => selectSession(session.id)}>
      <span className="icon">
        <ChatIcon size={14} />
      </span>
      <span className="name">{session.title || 'Untitled'}</span>
      <span className="meta">{timeAgo(session.time?.updated)}</span>
    </div>
  )
}

export function Sidebar(): React.JSX.Element {
  const sessions = useStore(appStore, (s) => s.sessions)
  const projects = useStore(appStore, (s) => s.projects)
  const activeSessionId = useStore(appStore, (s) => s.activeSessionId)
  const serverHealthy = useStore(appStore, (s) => s.serverHealthy)
  const projectPath = useStore(appStore, (s) => s.projectPath)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const sessionsByPath = new Map<string, SessionInfo[]>()
  for (const session of sessions) {
    const key = session.directory || session.path || ''
    const list = sessionsByPath.get(key) ?? []
    list.push(session)
    sessionsByPath.set(key, list)
  }
  const looseChats = sessionsByPath.get('') ?? []
  const projectPaths = Array.from(
    new Set(
      [
        ...projects.map((p) => p.worktree ?? p.directory ?? p.path ?? '').filter(Boolean),
        ...sessionsByPath.keys()
      ].filter(Boolean)
    )
  )
  const activePath = projectPath

  const toggle = (path: string): void => {
    const next = new Set(expanded)
    if (next.has(path)) {
      next.delete(path)
    } else {
      next.add(path)
    }
    setExpanded(next)
  }

  const open = (path: string): void => {
    if (path !== activePath) void openProject(path)
    else toggle(path)
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="logo">
          <span className="logo-mark">R</span>
          <span>Ralf</span>
        </div>
      </div>
      <button className="btn-new" onClick={() => void newSession()}>
        <PlusIcon size={15} />
        <span>New chat</span>
      </button>

      <SectionHeader label="Projects" onAdd={() => void openProjectFolder()} addTitle="Add a project folder" />
      <div className="list">
        {projectPaths.map((path) => {
          const isActive = path === activePath
          const isExpanded = expanded.has(path)
          const pathSessions = sessionsByPath.get(path) ?? []
          return (
            <div key={path}>
              <div className={`item dir ${isActive ? 'active' : ''}`} onClick={() => open(path)} title={path}>
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
                    <SessionRow key={session.id} session={session} active={session.id === activeSessionId} />
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

      <SectionHeader label="Chats" onAdd={() => void newSession()} addTitle="New chat" />
      <div className="list">
        {looseChats.map((session) => (
          <SessionRow key={session.id} session={session} active={session.id === activeSessionId} />
        ))}
        {looseChats.length === 0 && (
          <div style={{ padding: '4px 8px', fontSize: 12, color: 'var(--text-faint)' }}>No chats yet</div>
        )}
      </div>

      <div className="footer">
        <span className={`status-dot ${serverHealthy ? 'ok' : 'pulse'}`} />
        <span>{serverHealthy ? 'opencode ready' : 'starting…'}</span>
        <span className="right" style={{ marginLeft: 'auto', fontSize: 11 }}>
          {projectName(activePath) || ''}
        </span>
      </div>
    </aside>
  )
}
