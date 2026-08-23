import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore, appStore } from '../state/AppState'
import type { SessionInfo } from '@shared/opencode'
import type { ChangeRequestSummary } from '@shared/review'
import type { Workspace, WorkspaceTab, WorkspaceTabKind } from '@shared/workspace'
import type { OwnedResource } from '../lib/workspaces'
import type { SupervisedThread, SupervisionSnapshot } from '@shared/supervision'
import { OpenCode } from '../lib/opencode'
import { PROJECT_DRAG_TYPE, SESSION_DRAG_TYPE, TAB_DRAG_TYPE, findGroup, reorderPaths, resourcesByThread, walkGroups } from '../lib/workspaces'
import { ThreadCard } from './ThreadCard'
import { useHoverCard } from '../lib/use-hover-card'
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
  removeProject,
  reorderProjects,
  addResourceToSession,
  removeSessionWorktree,
  renameWorkspaceTab,
  revealWorkspaceTab,
  setNativeViewsSuspended,
  selectSession,
  sessionMetaFor,
  showPage,
  toggleArchive,
  togglePin,
  exportSessionMarkdown
} from '../lib/actions'
import { BACKEND_MARKS, ChatIcon, ChevronIcon, ExternalIcon, FilesIcon, FolderIcon, GearIcon, GlobeIcon, PanelIcon, PlusIcon, ReviewIcon, StarIcon, TerminalIcon } from './icons'
import { BACKEND_SHORT_LABELS } from '../lib/backend-labels'
import { IconButton } from './ui'

/** Threads shown per project before "Show N more". */
const THREADS_PER_PROJECT = 20

interface CtxMenu {
  x: number
  y: number
  project?: string
  session?: SessionInfo
  /** The pull request open on the session's worktree branch, if its checkout
   *  resolves one. Null once looked up and found absent; undefined while the
   *  lookup is in flight or the thread has no worktree branch at all. */
  changeRequest?: ChangeRequestSummary | null
  /** Set by the + on a thread row: the same popup, listing resources to add
   *  rather than the thread's own actions. */
  addTo?: SessionInfo
}

/** What a thread can own. No thread here: a pane holds one, and it arrives by
 *  being dragged or clicked, not from this menu. */
const ADDABLE: Array<{ kind: WorkspaceTabKind; label: string }> = [
  { kind: 'terminal', label: 'Terminal' },
  { kind: 'files', label: 'Files' },
  { kind: 'review', label: 'Review' },
  { kind: 'browser', label: 'Browser' }
]

/** A flyout for a row of the context menu.
 *
 *  The menu scrolls when it is taller than the window, and a scroll container
 *  clips its own overflow on both axes — CSS has no way to scroll one axis and
 *  let the other spill, since overflow-x: visible computes to auto beside an
 *  overflow-y. So the flyout cannot be a child of the menu and be seen. It is
 *  portalled to the body and positioned against the viewport instead, which
 *  also keeps it clear of the menu's own scrolling. */
function CtxSubmenu({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const rowRef = useRef<HTMLDivElement>(null)
  const flyoutRef = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)

  // Placed from the flyout's real size, not from an item count and an assumed
  // row height — those drift the moment a label wraps or the type scale
  // changes, and the error shows up as a flyout hanging off the bottom.
  //
  // A layout effect, so the measurement and the move both happen before the
  // browser paints: it is never seen in the corner it was measured in.
  useLayoutEffect(() => {
    if (!open) {
      setAt(null)
      return
    }
    const row = rowRef.current?.getBoundingClientRect()
    const flyout = flyoutRef.current?.getBoundingClientRect()
    if (!row || !flyout) return
    // Opens leftward when there is no room to the right, and is pulled up when
    // it would run off the bottom, the way the menu itself is.
    const left =
      row.right + flyout.width + 8 > window.innerWidth ? row.left - flyout.width - 2 : row.right + 2
    const top = Math.max(8, Math.min(row.top - 4, window.innerHeight - 8 - flyout.height))
    setAt({ left, top })
  }, [open])

  return (
    <div
      ref={rowRef}
      className="ctx-submenu"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button className={`ctx-item ctx-parent ${open ? 'open' : ''}`}>
        <span>{label}</span>
        <span className="ctx-arrow">›</span>
      </button>
      {open
        ? createPortal(
            <div
              ref={flyoutRef}
              className="ctx-submenu-items"
              // Rendered at the row so it can be measured, then moved to its
              // final place by the layout effect above — both before paint.
              style={at ? { left: at.left, top: at.top } : { left: 0, top: 0 }}
              onMouseEnter={() => setOpen(true)}
              onMouseLeave={() => setOpen(false)}
            >
              {children}
            </div>,
            document.body
          )
        : null}
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

/** The one tab the user is working in: active tab, focused pane, active view. */
function focusedTab(workspace: Workspace | null): WorkspaceTab | undefined {
  if (!workspace) return undefined
  const view = workspace.views.find((item) => item.id === workspace.activeViewId)
  if (!view) return undefined
  const group = findGroup(view.root, view.focusedGroupId) ?? walkGroups(view.root)[0]
  return group?.tabs.find((item) => item.id === group.activeTabId)
}


function SessionRow({
  session,
  onCtx,
  resourceCount = 0,
  expanded = false,
  onToggle
}: {
  session: SessionInfo
  onCtx: (e: React.MouseEvent, s: SessionInfo) => void
  resourceCount?: number
  expanded?: boolean
  onToggle?: () => void
}): React.JSX.Element {
  // One highlight, on the tab of the focused pane. A split view shows several
  // tabs at once, but marking them all needs a second visual state the sidebar
  // cannot explain. Not activeSessionId either: that is the session being
  // chatted with, and it stayed lit long after you looked elsewhere.
  const showing = useStore(appStore, (state) => {
    const tab = focusedTab(state.projectWorkspace)
    return tab?.kind === 'thread' && tab.sessionId === session.id
  })
  const meta = sessionMetaFor(session.id)
  const card = useHoverCard()
  const busy = useStore(appStore, (s) => Boolean(s.sessionBusy[session.id]))
  const compacting = useStore(appStore, (s) => Boolean(s.compacting[session.id]))
  const preferredModel = useStore(appStore, (s) => s.modelsBySession[session.id])
  const model = preferredModel ?? session.model?.id
  const BackendMark = BACKEND_MARKS[session.backendId ?? 'opencode'] ?? ChatIcon
  const details = [
    BACKEND_SHORT_LABELS[session.backendId ?? 'opencode'],
    model?.split('/').pop(),
    session.worktree?.status === 'active' ? session.worktree.branch : undefined,
    session.worktree?.status === 'removed' ? 'Worktree cleaned' : undefined,
    meta?.kind === 'fork' ? 'Fork' : undefined,
    meta?.kind === 'side' ? 'Side chat' : undefined,
    compacting ? 'Compacting' : busy ? 'Working' : undefined
  ].filter(Boolean)
  return (
    <div
      className={`item sub session-row ${session.pinned ? 'pinned' : ''} ${showing ? 'active' : ''}`}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData(SESSION_DRAG_TYPE, session.id)
      }}
      onClick={() => selectSession(session.id)}
      onContextMenu={(e) => onCtx(e, session)}
      // No title attribute: the native tooltip covers the card and cannot be
      // told to wait, so the two fight over the same pointer rest.
      {...card.handlers}
    >
      {card.at ? <ThreadCard session={session} origin={meta?.forkedFrom?.sessionId} at={card.at} /> : null}
      <span
        className={`session-caret ${expanded ? 'open' : ''} ${resourceCount ? '' : 'leaf'}`}
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
      {/* One line, not two. The model, the branch and the run state are what the hover card is
          for; repeating them under every title cost the list a second line of dim text.
          The backend rides along as its own mark rather than as a word, for the same reason the
          tabs carry one: "OpenCode" spelled out takes width the title needs. */}
      <span className="session-copy">
        <span className={`session-backend backend-${session.backendId ?? 'opencode'}`} title={details.join(' · ')}>
          <BackendMark size={13} />
        </span>
        <span className="name">{session.title || 'Untitled'}</span>
      </span>
      <button
        className={`session-pin ${session.pinned ? 'pinned' : ''}`}
        aria-label={session.pinned ? 'Unpin thread' : 'Pin thread'}
        title={session.pinned ? 'Unpin thread' : 'Pin thread'}
        onClick={(event) => {
          // The row itself selects; a pin click is only a pin.
          event.stopPropagation()
          togglePin(session.id)
        }}
      >
        <StarIcon size={12} />
      </button>
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
  // Same single highlight as thread rows: the focused pane's active tab.
  const active = useStore(appStore, (state) => focusedTab(state.projectWorkspace)?.id === resource.id)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const label = resource.title || RESOURCE_LABELS[resource.kind] || resource.kind
  const commit = (): void => {
    setEditing(false)
    if (draft !== (resource.title ?? '')) renameWorkspaceTab(resource.id, draft)
  }
  return (
    <div
      className={`item resource-row ${active ? 'active' : ''}`}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData(TAB_DRAG_TYPE, resource.id)
      }}
      onClick={() => revealWorkspaceTab(resource.viewId, resource.groupId, resource.id)}
      onDoubleClick={(event) => {
        event.stopPropagation()
        setDraft(resource.title ?? '')
        setEditing(true)
      }}
      title={`${label} — double-click to rename, drag into a view to move`}
    >
      <span className="icon"><Icon size={13} /></span>
      {editing ? (
        <input
          className="resource-rename"
          autoFocus
          value={draft}
          aria-label="Resource name"
          placeholder={RESOURCE_LABELS[resource.kind] ?? resource.kind}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit()
            if (event.key === 'Escape') setEditing(false)
          }}
        />
      ) : (
        <span className="name">{label}</span>
      )}
      <span className="resource-where">{resource.viewName}</span>
    </div>
  )
}

export function Sidebar(): React.JSX.Element {
  const sessions = useStore(appStore, (s) => s.sessions)
  const projects = useStore(appStore, (s) => s.projects)
  const activePage = useStore(appStore, (s) => s.activePage)
  const archived = useStore(appStore, (s) => s.archived)
  const backends = useStore(appStore, (s) => s.backends)
  const workspace = useStore(appStore, (s) => s.projectWorkspace)
  const activeSessionId = useStore(appStore, (s) => s.activeSessionId)
  const [tab, setTab] = useState<'projects' | 'chats' | 'review'>(() => {
    try {
      const saved = localStorage.getItem('boss.sidebarTab')
      return saved === 'chats' || saved === 'review' ? saved : 'projects'
    } catch { return 'projects' }
  })
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [liftedCaps, setLiftedCaps] = useState<Set<string>>(new Set())
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
  // Review lists threads by what they need rather than by where they live. The
  // supervision snapshot is the only place attention and results exist, so this
  // panel polls it: the sidebar's own session list has neither.
  const [supervision, setSupervision] = useState<SupervisionSnapshot | null>(null)
  useEffect(() => {
    if (tab !== 'review') return
    let disposed = false
    const refresh = (): void => {
      void OpenCode.supervision().then((value) => {
        if (!disposed) setSupervision(value)
      }).catch(() => {})
    }
    refresh()
    const timer = window.setInterval(refresh, 5_000)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [tab])

  /** Threads grouped by what they want from the user.
   *
   *  Order is the point: what blocks you, then what is finished and waiting on
   *  a decision, then what is still going. A thread lands in exactly one
   *  bucket, so the counts add up to the list. */
  const reviewBuckets = useMemo(() => {
    const threads = supervision?.threads ?? []
    const needs: Array<{ thread: SupervisedThread; detail: string }> = []
    const ready: Array<{ thread: SupervisedThread; detail: string }> = []
    const running: Array<{ thread: SupervisedThread; detail: string }> = []
    for (const thread of threads) {
      const attention = thread.attention
      if (attention?.kind === 'permission') needs.push({ thread, detail: 'Needs permission' })
      else if (attention?.kind === 'question') needs.push({ thread, detail: 'Needs an answer' })
      else if (attention?.kind === 'error' || thread.lastRun?.status === 'error') {
        needs.push({ thread, detail: attention?.detail ?? 'Run failed' })
      } else if (thread.running) running.push({ thread, detail: 'Working' })
      else if (thread.result?.changedFiles) {
        const files = thread.result.changedFiles
        ready.push({ thread, detail: `${files} file${files === 1 ? '' : 's'} changed` })
      }
    }
    return [
      { label: 'Needs you', threads: needs },
      { label: 'Ready to review', threads: ready },
      { label: 'Running', threads: running }
    ].filter((bucket) => bucket.threads.length > 0)
  }, [supervision])

  const needsYouCount = reviewBuckets.find((bucket) => bucket.label === 'Needs you')?.threads.length ?? 0

  const [ctx, setCtx] = useState<CtxMenu | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  /** Where the menu ends up once its height is known.
   *
   *  It opens at the pointer, which runs off the bottom in a short window or on
   *  a click near it — and the menu grew as thread actions were added, so this
   *  gets easier to hit over time. Measured rather than guessed: it is a
   *  different height for a project, a thread, and a thread with a worktree. */
  const [menuTop, setMenuTop] = useState<number | null>(null)
  useEffect(() => {
    if (!ctx) {
      setMenuTop(null)
      return
    }
    const height = menuRef.current?.offsetHeight ?? 0
    const overflow = ctx.y + height - (window.innerHeight - 8)
    setMenuTop(overflow > 0 ? Math.max(8, ctx.y - overflow) : ctx.y)
  }, [ctx])
  const projectsRef = useRef<HTMLDivElement>(null)
  /** The project being dragged, and where it would land. Held here rather than
   *  read back from the drag event: dragover fires constantly, and Chromium
   *  hides the payload until the drop, so the line has nothing else to follow. */
  const [dragProject, setDragProject] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<{ path: string; before: boolean } | null>(null)
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
  const archivedSet = new Set(archived)
  const query = filter.trim().toLowerCase()
  // Matching on the project too, so "cage" finds every thread in that project
  // without expanding it — the point of filtering is not to drill.
  const matches = (session: SessionInfo): boolean => {
    if (!query) return true
    const where = session.projectPath ?? session.directory ?? session.path ?? ''
    return `${session.title ?? ''} ${where}`.toLowerCase().includes(query)
  }
  // Archived now lives on the thread so every client agrees. The local set is
  // still consulted while the one-time migration from localStorage is in
  // flight, and for the optimistic update before the snapshot lands.
  const isArchived = (session: SessionInfo): boolean => session.archived === true || archivedSet.has(session.id)
  const visibleSessions = sessions.filter((s) => !isArchived(s) && !s.parentID && matches(s))
  const archivedSessions = sessions.filter((s) => isArchived(s) && matches(s))

  /** Pinned threads above the rest, each half keeping its recency order.
   *  Sorting inside the halves matters where a backend's list was not built
   *  newest-first; partitioning keeps a pin meaning "top of the section". */
  const pinnedFirst = (list: SessionInfo[]): SessionInfo[] => {
    const byRecency = (a: SessionInfo, b: SessionInfo): number => (b.time?.updated ?? 0) - (a.time?.updated ?? 0)
    return [
      ...list.filter((session) => session.pinned === true).sort(byRecency),
      ...list.filter((session) => session.pinned !== true).sort(byRecency)
    ]
  }

  const sessionsByPath = new Map<string, SessionInfo[]>()
  for (const session of visibleSessions) {
    const raw = session.projectPath ?? session.directory ?? session.path ?? ''
    const key = raw === '/' ? '' : raw
    const list = sessionsByPath.get(key) ?? []
    list.push(session)
    sessionsByPath.set(key, list)
  }
  for (const [key, list] of sessionsByPath) sessionsByPath.set(key, pinnedFirst(list))
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
  // A browser is a native view composited over the page, so it ignores
  // z-index: a menu opening near one drew underneath it. Detach while the
  // menu is up, as the workspace menus already do.
  useEffect(() => {
    setNativeViewsSuspended('sidebar-menu', Boolean(ctx))
    return () => setNativeViewsSuspended('sidebar-menu', false)
  }, [ctx])

  useEffect(() => {
    if (!ctx) return
    const close = (): void => setCtx(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    const onDoc = (e: MouseEvent): void => {
      const target = e.target as Node
      if (!menuRef.current || menuRef.current.contains(target)) return
      // A submenu is portalled to the body to escape the menu's scrolling, so
      // it is not inside menuRef. Without this a click on Add's items closed
      // the menu on mousedown and the item never received the click.
      if ((target as Element).closest?.('.ctx-submenu-items')) return
      close()
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [ctx])

  const selectTab = (next: 'projects' | 'chats' | 'review'): void => {
    setTab(next)
    try { localStorage.setItem('boss.sidebarTab', next) } catch { /* ignore */ }
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
    // Surface the pull request the thread's checkout has open, the same lookup
    // the hover card does, so the menu can remind the user what the thread
    // produced. Any live checkout qualifies: the snapshot resolves the branch
    // with git, so gating on the thread's stored worktree only hid pull
    // requests that were really there. Resolved asynchronously and merged back
    // by thread id so a fetch for one thread never paints a later menu.
    const path = session.executionPath ?? session.projectPath ?? session.directory ?? session.path
    if (!path || session.worktree?.status === 'removed') return
    void window.boss
      .reviewSnapshot(path)
      .then((snapshot) => {
        setCtx((prev) =>
          prev?.session?.id === session.id
            ? { ...prev, changeRequest: snapshot.changeRequest ?? null }
            : prev
        )
      })
      .catch(() => {
        // A checkout that has gone is not worth erroring the menu over.
        setCtx((prev) => (prev?.session?.id === session.id ? { ...prev, changeRequest: null } : prev))
      })
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

      <div className="sidebar-tabs" role="tablist" aria-label="Sidebar sections">
        <button
          role="tab"
          aria-selected={tab === 'projects'}
          className={`sidebar-tab ${tab === 'projects' ? 'active' : ''}`}
          onClick={() => selectTab('projects')}
        >
          Projects
        </button>
        <button
          role="tab"
          aria-selected={tab === 'chats'}
          className={`sidebar-tab ${tab === 'chats' ? 'active' : ''}`}
          onClick={() => selectTab('chats')}
        >
          Chats{looseChats.length ? <small>{looseChats.length}</small> : null}
        </button>
        <button
          role="tab"
          aria-selected={tab === 'review'}
          className={`sidebar-tab ${tab === 'review' ? 'active' : ''}`}
          onClick={() => selectTab('review')}
        >
          Review{needsYouCount ? <small>{needsYouCount}</small> : null}
        </button>
        {tab === 'review' ? null : (
          <IconButton
            size="small"
            className="section-add"
            onClick={() => (tab === 'projects' ? void openProjectFolder() : void newGlobalChat())}
            label={tab === 'projects' ? 'New project' : 'New chat'}
          >
            <PlusIcon size={12} />
          </IconButton>
        )}
      </div>

      {/* Above the tabs: matches() filters loose chats as well as project
          threads, so one box serves both panels. */}
      <div className="sidebar-filter" hidden={tab === 'review'}>
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={tab === 'projects' ? 'Filter threads' : 'Filter chats'}
          aria-label={tab === 'projects' ? 'Filter threads' : 'Filter chats'}
          spellCheck={false}
        />
        {filter ? (
          <button className="sidebar-filter-clear" onClick={() => setFilter('')} aria-label="Clear filter">×</button>
        ) : null}
      </div>

      <div className="sidebar-section projects" hidden={tab !== 'projects'}>
        <div
          className="list"
          ref={projectsRef}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            // A project dropped on the gaps between rows lands here rather than
            // on a row. There is no row to order it against, so the drag is
            // abandoned — but the indicator still has to go.
            setDragProject(null)
            setDropAt(null)
            const dropped = e.dataTransfer?.files?.[0] as File & { path?: string } | undefined
            const path = dropped?.path
            if (path) void openProject(path)
          }}
        >
        {projectPaths.map((path) => {
          const pathSessions = sessionsByPath.get(path) ?? []
          // A project is a folder in the tree, not a thing you select. Clicking
          // it opens and shuts it. Filtering opens every project that matched,
          // since hunting through shut folders is what search replaces.
          const isOpen = !collapsed.has(path) || Boolean(query)
          const uncapped = liftedCaps.has(path) || Boolean(query)
          const shown = uncapped ? pathSessions : pathSessions.slice(0, THREADS_PER_PROJECT)
          const hidden = pathSessions.length - shown.length
          return (
            <div key={path}>
              <div
                className={`item dir project-row${dragProject === path ? ' dragging' : ''}${
                  dropAt?.path === path ? (dropAt.before ? ' drop-before' : ' drop-after') : ''
                }`}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData(PROJECT_DRAG_TYPE, path)
                  setDragProject(path)
                }}
                onDragEnd={() => {
                  setDragProject(null)
                  setDropAt(null)
                }}
                onDragOver={(event) => {
                  if (!event.dataTransfer.types.includes(PROJECT_DRAG_TYPE)) return
                  // Claim the event before the list's own handler, which opens
                  // a folder dropped from Finder and would swallow this one.
                  event.preventDefault()
                  event.stopPropagation()
                  event.dataTransfer.dropEffect = 'move'
                  const box = event.currentTarget.getBoundingClientRect()
                  setDropAt({ path, before: event.clientY < box.top + box.height / 2 })
                }}
                onDragLeave={(event) => {
                  // Moving onto a child still counts as being on the row, so
                  // only clear when the pointer leaves the row itself.
                  if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
                  setDropAt((prev) => (prev?.path === path ? null : prev))
                }}
                onDrop={(event) => {
                  const moved = event.dataTransfer.getData(PROJECT_DRAG_TYPE)
                  if (!moved) return
                  event.preventDefault()
                  event.stopPropagation()
                  const before = dropAt?.path === path ? dropAt.before : true
                  setDragProject(null)
                  setDropAt(null)
                  const next = reorderPaths(projectPaths, moved, path, before)
                  if (next !== projectPaths) void reorderProjects(next)
                }}
                onClick={() =>
                  setCollapsed((prev) => {
                    const next = new Set(prev)
                    if (next.has(path)) next.delete(path)
                    else next.add(path)
                    return next
                  })
                }
                onContextMenu={(e) => onProjectCtx(e, path)}
                title={path}
              >
                <span className={`project-caret ${isOpen ? 'open' : ''}`}><ChevronIcon size={10} /></span>
                <span className="icon">
                  <FolderIcon size={15} />
                </span>
                <span className="project-row-copy">
                  <span className="name">{projectName(path)}</span>
                </span>
                <span className="meta">{pathSessions.length || ''}</span>
              </div>
              {isOpen ? shown.map(threadRow) : null}
              {isOpen && hidden > 0 ? (
                <div
                  className="sidebar-load-more nested"
                  onClick={(e) => {
                    e.stopPropagation()
                    setLiftedCaps((prev) => new Set(prev).add(path))
                  }}
                >
                  Show {hidden} more
                </div>
              ) : null}
              {isOpen && pathSessions.length === 0 ? (
                <div className="sidebar-empty nested">No chats yet</div>
              ) : null}
            </div>
          )
        })}
        {projectPaths.length === 0 && (
          <div className="sidebar-empty">No projects yet</div>
        )}
      </div>
      </div>

      <div className="sidebar-section chats" hidden={tab !== 'chats'}>
        <div className="list">
          {looseChats.map(threadRow)}
          {looseChats.length === 0 && (
            <div className="sidebar-empty">No chats yet</div>
          )}
        </div>
      </div>

      <div className="sidebar-section review" hidden={tab !== 'review'}>
        {reviewBuckets.map((bucket) => (
          <React.Fragment key={bucket.label}>
            <div className="section-label">{bucket.label}<small>{bucket.threads.length}</small></div>
            <div className="list">
              {bucket.threads.map((entry) => (
                <div
                  key={entry.thread.threadId}
                  className={`item sub session-row ${activeSessionId === entry.thread.threadId ? 'active' : ''}`}
                  onClick={() => selectSession(entry.thread.threadId)}
                  title={entry.thread.title}
                >
                  <span className={`session-state ${entry.thread.running ? 'busy' : 'idle'}`}><span /></span>
                  <span className="session-copy">
                    <span className="name">{entry.thread.title || 'Untitled'}</span>
                    <span className="session-details">{entry.detail}</span>
                  </span>
                </div>
              ))}
            </div>
          </React.Fragment>
        ))}
        {reviewBuckets.length === 0 && (
          <div className="sidebar-empty">{supervision ? 'Nothing needs you' : 'Loading…'}</div>
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
        <div
          ref={menuRef}
          className="ctx-menu"
          // 328px is the menu's own max-width plus the 8px gutter the top and
          // bottom edges get, so the widest menu still lands fully on screen.
          style={{ left: Math.max(8, Math.min(ctx.x, window.innerWidth - 328)), top: menuTop ?? ctx.y }}
        >
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
              {menuItem('Remove project…', () => {
                const path = ctx.project!
                const threads = sessions.filter(
                  (session) => (session.projectPath ?? session.directory ?? session.path) === path
                ).length
                appStore.setState({
                  confirm: {
                    title: 'Remove project?',
                    message: threads
                      ? `Remove ${projectName(path)} from BOSS, along with ${threads} thread${threads === 1 ? '' : 's'}? The folder itself is left on disk.`
                      : `Remove ${projectName(path)} from BOSS? The folder itself is left on disk.`,
                    confirmLabel: 'Remove',
                    destructive: true,
                    action: () => void removeProject(path)
                  }
                })
              })}
            </>
          ) : ctx.session ? (
            <>
              {menuItem('Open', () => selectSession(ctx.session!.id))}
              {ctx.changeRequest ? (
                <button
                  className="ctx-item ctx-pr"
                  onClick={() => {
                    if (!ctx.changeRequest) return
                    const url = ctx.changeRequest.url
                    setCtx(null)
                    void window.boss.openExternal(url)
                  }}
                >
                  <ReviewIcon size={13} />
                  <span className="ctx-pr-id">{ctx.changeRequest.displayId}</span>
                  <span className="ctx-pr-title">{ctx.changeRequest.title}</span>
                  <ExternalIcon size={12} />
                </button>
              ) : null}
              {/* A chat has no checkout, so a terminal or diff has nowhere to
                  point and Add is left out entirely. */}
              {(ctx.session.projectPath ?? ctx.session.directory ?? ctx.session.path) ? (
                <CtxSubmenu label="Add">
                  {ADDABLE.map(({ kind, label }) => {
                    const Icon = RESOURCE_ICONS[kind] ?? ChatIcon
                    return (
                      <button
                        key={kind}
                        className="ctx-item"
                        onClick={() => {
                          const target = ctx.session!
                          setCtx(null)
                          addResourceToSession(target.id, kind)
                        }}
                      >
                        <Icon size={13} />
                        <span>{label}</span>
                      </button>
                    )
                  })}
                </CtxSubmenu>
              ) : null}
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
              {ctx.session.pinned ? (
                menuItem('Unpin', () => togglePin(ctx.session!.id))
              ) : (
                menuItem('Pin to top', () => togglePin(ctx.session!.id))
              )}
              {menuItem('Export as Markdown…', () => void exportSessionMarkdown(ctx.session!.id))}
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
              {menuItem('Copy ID', () => window.boss.clipboardWrite(ctx.session!.id))}
            </>
          ) : null}
        </div>
      )}
    </aside>
    <div className="sidebar-width-divider" onMouseDown={onWidthDividerDown} title="Drag to resize sidebar" />
    </>
  )
}
