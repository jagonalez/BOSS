import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { DropPosition, WorkspaceCheckoutBinding, WorkspaceGroup, WorkspaceNode, WorkspaceSplit, WorkspaceTab, WorkspaceTabKind } from '@shared/workspace'
import { useStore, appStore } from '../state/AppState'
import { ChatView } from './ChatView'
import { BrowseTab } from './BrowseTab'
import { TerminalTab } from './TerminalTab'
import { ReviewTab } from './ReviewTab'
import { FilesTab } from './FilesTab'
import {
  activateWorkspaceView,
  activateWorkspaceTab,
  addWorkspaceTab,
  applyLayoutTemplate,
  closeWorkspaceView,
  closeWorkspaceGroup,
  closeWorkspaceTab,
  createWorkspaceView,
  createThreadInGroup,
  focusWorkspaceGroup,
  loadMessages,
  loadTodos,
  removeLayoutTemplate,
  renameWorkspaceView,
  reorderWorkspaceTab,
  saveCurrentLayoutTemplate,
  sendWorkspaceTabToView,
  setNativeViewsSuspended,
  setWorkspaceSplitRatio,
  splitWorkspaceGroup
} from '../lib/actions'
import { TAB_DRAG_TYPE, activeWorkspaceView, findGroup, walkTabs, workspaceMenuRight } from '../lib/workspaces'
import { ChatIcon, FilesIcon, GlobeIcon, PlusIcon, ReviewIcon, TerminalIcon } from './icons'
import { BackendBadge } from './BackendControls'


const TAB_TYPES: Array<{
  kind: WorkspaceTabKind
  label: string
  icon: (props: { size?: number }) => React.JSX.Element
}> = [
  { kind: 'thread', label: 'Thread', icon: ChatIcon },
  { kind: 'browser', label: 'Browser', icon: GlobeIcon },
  { kind: 'terminal', label: 'Terminal', icon: TerminalIcon },
  { kind: 'review', label: 'Review', icon: ReviewIcon },
  { kind: 'files', label: 'Files', icon: FilesIcon }
]

function tabIcon(kind: WorkspaceTabKind): (props: { size?: number }) => React.JSX.Element {
  return TAB_TYPES.find((item) => item.kind === kind)?.icon ?? ChatIcon
}

function isLiveSurface(item: WorkspaceTab): boolean {
  return item.kind === 'browser' || item.kind === 'terminal'
}

function requestCloseWorkspaceTab(groupId: string, item: WorkspaceTab): void {
  if (item.kind !== 'terminal') {
    closeWorkspaceTab(groupId, item.id)
    return
  }

  appStore.setState({
    confirm: {
      title: 'Close terminal?',
      message: 'This closes the terminal and ends its running shell and processes.',
      confirmLabel: 'Close terminal',
      destructive: true,
      action: () => closeWorkspaceTab(groupId, item.id)
    }
  })
}

function requestCloseWorkspaceGroup(group: WorkspaceGroup): void {
  const terminals = group.tabs.filter((item) => item.kind === 'terminal').length
  if (terminals === 0) {
    closeWorkspaceGroup(group.id)
    return
  }

  appStore.setState({
    confirm: {
      title: 'Close pane?',
      message: terminals === 1
        ? 'This closes the terminal and ends its running shell and processes.'
        : `This closes ${terminals} terminals and ends their running shells and processes.`,
      confirmLabel: 'Close pane',
      destructive: true,
      action: () => closeWorkspaceGroup(group.id)
    }
  })
}

function useTabLabel(item: WorkspaceTab, group: WorkspaceGroup): string {
  const sessionTitle = useStore(appStore, (state) => state.sessions.find((session) => session.id === item.sessionId)?.title)
  const browserTitle = useStore(appStore, (state) => state.browse[`workspace-${item.id}`]?.title)
  const authBackendId = useStore(appStore, (state) => state.authTerminalBackends?.[item.id])
  const sameKindIndex = group.tabs.filter((candidate) => candidate.kind === item.kind).findIndex((candidate) => candidate.id === item.id)
  const suffix = sameKindIndex > 0 ? ` ${sameKindIndex + 1}` : ''
  if (item.kind === 'thread') return sessionTitle || 'Untitled thread'
  if (item.kind === 'browser') return browserTitle || `Browser${suffix}`
  if (item.kind === 'terminal' && authBackendId) {
    const label = { opencode: 'OpenCode', pi: 'Pi', codex: 'Codex', claude: 'Claude' }[authBackendId]
    return `Connect ${label}`
  }
  const label = `${TAB_TYPES.find((candidate) => candidate.kind === item.kind)?.label ?? item.kind}${suffix}`
  return item.contextLabel && (item.kind === 'terminal' || item.kind === 'review' || item.kind === 'files')
    ? `${label} · ${item.contextLabel}`
    : label
}

function TabLabel({ item, group }: { item: WorkspaceTab; group: WorkspaceGroup }): React.JSX.Element {
  const label = useTabLabel(item, group)
  const backendId = useStore(appStore, (state) => state.sessions.find((session) => session.id === item.sessionId)?.backendId)
  const Icon = tabIcon(item.kind)
  const busy = useStore(appStore, (state) => Boolean(item.sessionId && state.streaming[item.sessionId]))
  const permission = useStore(appStore, (state) => Boolean(item.sessionId && state.permissions[item.sessionId]))
  const failed = useStore(appStore, (state) => Boolean(item.sessionId && state.lastErrorBySession[item.sessionId]))
  const busActivity = useStore(appStore, (state) => Boolean(item.sessionId && state.threadBus?.messages.some((message) =>
    (message.fromThreadId === item.sessionId || message.toThreadId === item.sessionId) && message.status !== 'delivered'
  )))

  return (
    <>
      <span className={`workspace-tab-icon ${busy ? 'working' : ''} ${permission ? 'attention' : ''} ${failed ? 'failed' : ''}`}>
        <Icon size={12} />
      </span>
      <span className="workspace-tab-label" title={label}>{label}</span>
      {item.kind === 'thread' ? <BackendBadge backendId={backendId} /> : null}
      {busActivity ? <span className="workspace-tab-bus" title="Thread message queued or failed" /> : null}
    </>
  )
}

/** Start a thread in an empty pane. The long list of existing threads is gone:
 *  that is the sidebar's job, and dragging one in beats searching a menu. */
function NewThreadButtons({ groupId, close }: { groupId: string; close: () => void }): React.JSX.Element {
  const backends = useStore(appStore, (state) => state.backends)
  return (
    <div className="workspace-new-thread-backends">
      {backends.map((backend) => (
        <button
          key={backend.id}
          className="workspace-add-menu-item primary"
          disabled={!backend.available}
          title={backend.available ? `New ${backend.label} thread` : backend.unavailableReason}
          onClick={() => {
            close()
            void createThreadInGroup(groupId, backend.id)
          }}
        >
          <PlusIcon size={14} />
          <BackendBadge backendId={backend.id} />
        </button>
      ))}
    </div>
  )
}

function checkoutPath(session: { executionPath?: string; worktree?: { path: string } }): string | undefined {
  return session.executionPath ?? session.worktree?.path
}

function AddMenu({ groupId, close }: { groupId: string; close: () => void }): React.JSX.Element {
  const projectPath = useStore(appStore, (state) => state.projectPath)
  const sessions = useStore(appStore, (state) => state.sessions)
  const activeSessionId = useStore(appStore, (state) => state.activeSessionId)
  const workspace = useStore(appStore, (state) => state.projectWorkspace)

  // A resource belongs to the thread it was opened from, so it takes that
  // thread's checkout — including its worktree — rather than asking. Picking
  // from a list of every worktree on disk made the user answer a question the
  // thread had already answered.
  const ownerId = useMemo(() => {
    if (!workspace) return activeSessionId
    const owner = findGroup(activeWorkspaceView(workspace).root, groupId)
    return owner?.tabs.find((item) => item.kind === 'thread')?.sessionId ?? activeSessionId
  }, [workspace, groupId, activeSessionId])
  const owner = sessions.find((session) => session.id === ownerId)
  const inherited: WorkspaceCheckoutBinding | undefined = (() => {
    const path = checkoutPath(owner ?? {}) ?? projectPath
    if (!path) return undefined
    return {
      contextPath: path,
      worktreeId: owner?.worktree?.id,
      contextLabel: owner?.worktree?.branch ?? 'Main'
    }
  })()

  // A pane holds one thread and the resources belonging to it, so this menu
  // adds resources only. An existing thread is dragged in from the sidebar,
  // and an empty pane can start a new one below.
  const resources = TAB_TYPES.filter((item) => item.kind !== 'thread')
  const hasThread = Boolean(owner)

  return (
    <div className="workspace-add-menu">
      <div className="workspace-menu-title">
        {hasThread ? `Add to ${owner?.title || 'this thread'}` : 'Add to this pane'}
      </div>
      {resources.map(({ kind, label, icon: Icon }) => {
        const scoped = kind === 'terminal' || kind === 'review' || kind === 'files'
        return (
          <button
            key={kind}
            className="workspace-add-menu-item"
            onClick={() => {
              // Record the owning thread, not just its checkout. A resource can
              // be dragged into any view, so the sidebar needs to know which
              // thread to list it under once it no longer sits beside one.
              addWorkspaceTab(groupId, kind, scoped ? ownerId ?? undefined : undefined, scoped ? inherited : undefined)
              close()
            }}
          >
            <Icon size={14} />
            <span>{label}</span>
            {scoped ? <small>{inherited?.contextLabel ?? 'project'}</small> : null}
          </button>
        )
      })}
      {!hasThread ? (
        <>
          <div className="workspace-menu-rule" />
          <div className="workspace-menu-title">New thread</div>
          <NewThreadButtons groupId={groupId} close={close} />
          <div className="workspace-menu-note">Or drag one in from the sidebar.</div>
        </>
      ) : null}
    </div>
  )
}

function TabContent({
  groupId,
  item,
  active,
  overlayOpen
}: {
  groupId: string
  item: WorkspaceTab
  active: boolean
  overlayOpen: boolean
}): React.JSX.Element {
  const authBackendId = useStore(appStore, (state) => state.authTerminalBackends?.[item.id])
  useEffect(() => {
    if (item.kind !== 'thread' || !item.sessionId) return
    void loadMessages(item.sessionId)
    void loadTodos(item.sessionId)
  }, [item.kind, item.sessionId])

  let content: React.JSX.Element
  switch (item.kind) {
    case 'thread':
      content = item.sessionId ? <ChatView sessionId={item.sessionId} /> : <div className="workspace-unbound">Choose a thread for this tab.</div>
      break
    case 'browser':
      content = <BrowseTab id={`workspace-${item.id}`} visible={active && !overlayOpen} />
      break
    case 'terminal':
      content = (
        <TerminalTab
          authBackendId={authBackendId}
          contextPath={item.contextPath}
          onExit={() => closeWorkspaceTab(groupId, item.id)}
        />
      )
      break
    case 'review':
      content = <ReviewTab contextPath={item.contextPath} sessionId={item.sessionId} groupId={groupId} tabId={item.id} />
      break
    case 'files':
      content = <FilesTab contextPath={item.contextPath} />
      break
  }
  return <div className="workspace-tab-content" hidden={!active}>{content}</div>
}

function dropPosition(event: React.DragEvent, element: HTMLElement): DropPosition {
  const rect = element.getBoundingClientRect()
  const x = (event.clientX - rect.left) / rect.width
  const y = (event.clientY - rect.top) / rect.height
  const edge = 0.24
  if (x < edge) return 'left'
  if (x > 1 - edge) return 'right'
  if (y < edge) return 'top'
  if (y > 1 - edge) return 'bottom'
  return 'center'
}

function GroupView({ group }: { group: WorkspaceGroup }): React.JSX.Element {
  const workspace = useStore(appStore, (state) => state.projectWorkspace)
  const highlightedTabId = useStore(appStore, (state) => state.highlightedTabId)
  const view = workspace ? activeWorkspaceView(workspace) : null
  const focused = view?.focusedGroupId === group.id
  const arrived = Boolean(highlightedTabId && group.tabs.some((item) => item.id === highlightedTabId))
  const movable = Boolean(view && walkTabs(view.root).length > 1)
  const [menuOpen, setMenuOpen] = useState(group.tabs.length === 0)
  const [menuRight, setMenuRight] = useState<number | null>(null)
  const [dropTarget, setDropTarget] = useState<DropPosition | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const addButtonRef = useRef<HTMLButtonElement>(null)
  const activeId = group.tabs.some((item) => item.id === group.activeTabId) ? group.activeTabId : group.tabs[0]?.id ?? null

  useEffect(() => {
    if (!menuOpen) return
    const close = (event: MouseEvent): void => {
      const target = event.target as Node
      if (addButtonRef.current?.contains(target)) return
      if (menuRef.current && !menuRef.current.contains(target)) setMenuOpen(false)
    }
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', key)
    }
  }, [menuOpen])

  useEffect(() => {
    const reason = `workspace-group-${group.id}`
    const suspended = menuOpen || Boolean(dropTarget)
    setNativeViewsSuspended(reason, suspended)
    return () => setNativeViewsSuspended(reason, false)
  }, [group.id, menuOpen, dropTarget])

  const onDrop = (event: React.DragEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    const tabId = event.dataTransfer.getData(TAB_DRAG_TYPE)
    // Sidebar rows can carry a resource that lives in another view, so route
    // every drop through the cross-view move. It falls back to the ordinary
    // one when the source is already here.
    if (tabId && view) sendWorkspaceTabToView(tabId, view.id, group.id, dropTarget ?? 'center')
    setDropTarget(null)
  }

  return (
    <section
      className={`workspace-group ${focused ? 'focused' : ''} ${arrived ? 'arrived' : ''} ${menuRight !== null ? 'menu-anchored' : ''}`}
      style={{ '--workspace-add-menu-right': `${menuRight ?? 8}px` } as React.CSSProperties}
      data-workspace-group={group.id}
      onMouseDown={() => focusWorkspaceGroup(group.id)}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(TAB_DRAG_TYPE)) return
        const tabId = event.dataTransfer.getData(TAB_DRAG_TYPE)
        if (tabId && group.tabs.length === 1 && group.tabs[0]?.id === tabId) {
          setDropTarget(null)
          return
        }
        event.preventDefault()
        setDropTarget(dropPosition(event, event.currentTarget))
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null)
      }}
      onDrop={onDrop}
    >
      <header className="workspace-group-tabs">
        <div className="workspace-tabs" role="tablist">
          {group.tabs.map((item) => (
            <button
              key={item.id}
              className={`workspace-tab ${item.id === activeId ? 'active' : ''}`}
              role="tab"
              aria-selected={item.id === activeId}
              draggable={movable}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData(TAB_DRAG_TYPE, item.id)
                event.currentTarget.classList.add('dragging')
              }}
              onDragEnd={(event) => event.currentTarget.classList.remove('dragging')}
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes(TAB_DRAG_TYPE)) return
                event.preventDefault()
                event.stopPropagation()
              }}
              onDrop={(event) => {
                event.preventDefault()
                event.stopPropagation()
                const tabId = event.dataTransfer.getData(TAB_DRAG_TYPE)
                if (tabId && tabId !== item.id && view) {
                  // Also the landing spot for a resource dragged out of the
                  // sidebar, which may still live in another view.
                  sendWorkspaceTabToView(tabId, view.id, group.id, 'center')
                  reorderWorkspaceTab(group.id, tabId, item.id)
                }
              }}
              onClick={() => activateWorkspaceTab(group.id, item.id)}
            >
              <TabLabel item={item} group={group} />
              <span
                className={`workspace-tab-close ${isLiveSurface(item) ? 'destructive' : ''}`}
                role="button"
                title={isLiveSurface(item) ? `Close ${item.kind}` : 'Hide this surface'}
                onClick={(event) => {
                  event.stopPropagation()
                  requestCloseWorkspaceTab(group.id, item)
                }}
              >{isLiveSurface(item) ? '×' : '−'}</span>
            </button>
          ))}
          <button
            ref={addButtonRef}
            className="workspace-tab-add"
            title="Add tab"
            onClick={(event) => {
              event.stopPropagation()
              const trigger = event.currentTarget.getBoundingClientRect()
              const container = event.currentTarget.closest('.workspace-group')?.getBoundingClientRect()
              setMenuRight(container
                ? workspaceMenuRight(trigger.right, container.left, container.right)
                : 8)
              setMenuOpen((open) => !open)
            }}
          >
            <PlusIcon size={13} />
          </button>
        </div>
        <div className="workspace-group-actions">
          <button onClick={() => splitWorkspaceGroup(group.id, 'horizontal')} title="Split left and right">↔</button>
          <button onClick={() => splitWorkspaceGroup(group.id, 'vertical')} title="Split top and bottom">↕</button>
          <button
            onClick={() => requestCloseWorkspaceGroup(group)}
            title={group.tabs.some(isLiveSurface) ? 'Close pane and its live resources' : 'Hide pane'}
          >{group.tabs.some(isLiveSurface) ? '×' : '−'}</button>
        </div>
      </header>

      <div className="workspace-group-content">
        {group.tabs.length === 0 ? (
          <button className="workspace-empty-group" onClick={() => {
            setMenuRight(null)
            setMenuOpen(true)
          }}>
            <PlusIcon size={18} />
            <span>Add a thread or tool</span>
          </button>
        ) : null}
        {group.tabs.map((item) => (
          <TabContent
            key={item.id}
            groupId={group.id}
            item={item}
            active={item.id === activeId}
            overlayOpen={menuOpen || Boolean(dropTarget)}
          />
        ))}
      </div>

      {menuOpen ? <div ref={menuRef}><AddMenu groupId={group.id} close={() => setMenuOpen(false)} /></div> : null}
      {dropTarget ? <div className={`workspace-drop-target ${dropTarget}`}><span>{dropTarget === 'center' ? 'Move into pane' : `Split ${dropTarget}`}</span></div> : null}
    </section>
  )
}

function SplitView({ node }: { node: WorkspaceSplit }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const onMouseDown = (event: React.MouseEvent): void => {
    event.preventDefault()
    const move = (next: MouseEvent): void => {
      const rect = ref.current?.getBoundingClientRect()
      if (!rect) return
      const ratio = node.direction === 'horizontal'
        ? (next.clientX - rect.left) / rect.width
        : (next.clientY - rect.top) / rect.height
      setWorkspaceSplitRatio(node.id, ratio)
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.classList.remove('workspace-resizing')
    }
    document.body.classList.add('workspace-resizing')
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  return (
    <div ref={ref} className={`workspace-split ${node.direction}`}>
      <div className="workspace-split-child" style={{ flexBasis: `${node.ratio * 100}%` }}><WorkspaceNodeView node={node.first} /></div>
      <div className="workspace-splitter" onMouseDown={onMouseDown} />
      <div className="workspace-split-child" style={{ flexBasis: `${(1 - node.ratio) * 100}%` }}><WorkspaceNodeView node={node.second} /></div>
    </div>
  )
}

function WorkspaceNodeView({ node }: { node: WorkspaceNode }): React.JSX.Element {
  return node.type === 'group' ? <GroupView group={node} /> : <SplitView node={node} />
}

function WorkspaceBar(): React.JSX.Element {
  const workspace = useStore(appStore, (state) => state.projectWorkspace)
  const templates = useStore(appStore, (state) => state.layoutTemplates)
  const [formatsOpen, setFormatsOpen] = useState(false)
  const [editingViewId, setEditingViewId] = useState<string | null>(null)
  const [viewNameDraft, setViewNameDraft] = useState('')
  const menuRef = useRef<HTMLDivElement>(null)
  const viewNameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!formatsOpen) return
    const close = (event: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setFormatsOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [formatsOpen])

  useEffect(() => {
    setNativeViewsSuspended('workspace-formats', formatsOpen)
    return () => setNativeViewsSuspended('workspace-formats', false)
  }, [formatsOpen])

  useEffect(() => {
    if (!editingViewId) return
    viewNameRef.current?.focus()
    viewNameRef.current?.select()
  }, [editingViewId])

  const apply = (id: string): void => {
    setFormatsOpen(false)
    appStore.setState({
      confirm: {
        title: 'Apply format?',
        message: 'This replaces the current group arrangement. Threads and their history are not deleted.',
        confirmLabel: 'Apply format',
        action: () => applyLayoutTemplate(id)
      }
    })
  }

  const saveFormat = (): void => {
    const name = window.prompt('Name this format')?.trim()
    if (name) saveCurrentLayoutTemplate(name)
  }

  const beginRename = (viewId: string, current: string): void => {
    setEditingViewId(viewId)
    setViewNameDraft(current)
  }

  const finishRename = (): void => {
    if (!editingViewId) return
    const name = viewNameDraft.trim()
    if (name) renameWorkspaceView(editingViewId, name)
    setEditingViewId(null)
  }

  return (
    <div className="workspace-bar">
      <div className="workspace-view-tabs" role="tablist" aria-label="Project views">
        {workspace?.views.map((view) => (
          <div
            key={view.id}
            className={`workspace-view-tab ${view.id === workspace.activeViewId ? 'active' : ''}`}
            role="tab"
            tabIndex={0}
            aria-selected={view.id === workspace.activeViewId}
            title={`${view.name} — double-click to rename`}
            onClick={() => {
              if (editingViewId !== view.id) activateWorkspaceView(view.id)
            }}
            onKeyDown={(event) => {
              if (editingViewId || (event.key !== 'Enter' && event.key !== ' ')) return
              event.preventDefault()
              activateWorkspaceView(view.id)
            }}
            onDoubleClick={(event) => {
              event.stopPropagation()
              beginRename(view.id, view.name)
            }}
          >
            {editingViewId === view.id ? (
              <input
                ref={viewNameRef}
                className="workspace-view-name-input"
                value={viewNameDraft}
                aria-label="View name"
                onChange={(event) => setViewNameDraft(event.target.value)}
                onClick={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                onBlur={finishRename}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') finishRename()
                  if (event.key === 'Escape') setEditingViewId(null)
                }}
              />
            ) : <span>{view.name}</span>}
            {workspace.views.length > 1 ? (
              <span
                className="workspace-view-close"
                role="button"
                title="Close view (threads remain available)"
                onClick={(event) => {
                  event.stopPropagation()
                  closeWorkspaceView(view.id)
                }}
              >−</span>
            ) : null}
          </div>
        ))}
        <button className="workspace-view-add" title="New view" onClick={createWorkspaceView}>
          <PlusIcon size={13} />
        </button>
      </div>
      <div className="workspace-bar-spacer" />
      <div className="workspace-format-control" ref={menuRef}>
        <button className="workspace-bar-button" onClick={() => setFormatsOpen((open) => !open)}>Formats <span>⌄</span></button>
        {formatsOpen ? (
          <div className="workspace-format-menu">
            <div className="workspace-menu-title">Favourite formats</div>
            {templates.filter((item) => item.favorite).map((template) => (
              <div className="workspace-format-row" key={template.id}>
                <button onClick={() => apply(template.id)}>
                  <span>{template.name}</span><small>{template.builtIn ? 'Built in' : 'Custom'}</small>
                </button>
                {!template.builtIn ? (
                  <button className="workspace-format-delete" title="Delete format" onClick={() => removeLayoutTemplate(template.id)}>×</button>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <button className="workspace-bar-button" onClick={saveFormat}>Save format</button>
    </div>
  )
}

function focusNeighbor(direction: 'left' | 'right' | 'up' | 'down'): void {
  const state = appStore.getState()
  const currentId = state.projectWorkspace ? activeWorkspaceView(state.projectWorkspace).focusedGroupId : undefined
  if (!currentId) return
  const elements = Array.from(document.querySelectorAll<HTMLElement>('[data-workspace-group]'))
  const current = elements.find((item) => item.dataset.workspaceGroup === currentId)
  if (!current) return
  const source = current.getBoundingClientRect()
  const sx = source.left + source.width / 2
  const sy = source.top + source.height / 2
  const candidates = elements.flatMap((item) => {
    if (item === current) return []
    const rect = item.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    const valid = direction === 'left' ? x < sx : direction === 'right' ? x > sx : direction === 'up' ? y < sy : y > sy
    if (!valid) return []
    const primary = direction === 'left' || direction === 'right' ? Math.abs(x - sx) : Math.abs(y - sy)
    const secondary = direction === 'left' || direction === 'right' ? Math.abs(y - sy) : Math.abs(x - sx)
    return [{ id: item.dataset.workspaceGroup!, score: primary + secondary * 0.4 }]
  }).sort((a, b) => a.score - b.score)
  if (candidates[0]) focusWorkspaceGroup(candidates[0].id)
}

export function Workspace(): React.JSX.Element {
  const workspace = useStore(appStore, (state) => state.projectWorkspace)

  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey)) return
      const target = event.target as HTMLElement | null
      if (target?.matches('input, textarea, [contenteditable="true"]')) return
      const state = appStore.getState()
      const current = state.projectWorkspace
      if (!current) return
      const view = activeWorkspaceView(current)
      const focused = findGroupForKeyboard(view.root, view.focusedGroupId)
      if (!focused) return
      if (event.key.toLowerCase() === 'd') {
        event.preventDefault()
        splitWorkspaceGroup(focused.id, event.shiftKey ? 'vertical' : 'horizontal')
      } else if (event.key.toLowerCase() === 'w' && focused.activeTabId) {
        event.preventDefault()
        const activeTab = focused.tabs.find((item) => item.id === focused.activeTabId)
        if (activeTab) requestCloseWorkspaceTab(focused.id, activeTab)
      } else if (event.key.startsWith('Arrow')) {
        event.preventDefault()
        const direction = event.key.replace('Arrow', '').toLowerCase() as 'left' | 'right' | 'up' | 'down'
        focusNeighbor(direction)
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])

  if (!workspace) return <div className="workspace-loading">Open a project to load its views.</div>
  const view = activeWorkspaceView(workspace)
  return (
    <div className="workspace-shell">
      <WorkspaceBar />
      <div className="workspace-canvas"><WorkspaceNodeView node={view.root} /></div>
    </div>
  )
}

function findGroupForKeyboard(node: WorkspaceNode, id: string): WorkspaceGroup | undefined {
  if (node.type === 'group') return node.id === id ? node : undefined
  return findGroupForKeyboard(node.first, id) ?? findGroupForKeyboard(node.second, id)
}
