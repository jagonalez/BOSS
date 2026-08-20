import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DropPosition, Workspace as WorkspaceState, WorkspaceGroup, WorkspaceNode, WorkspaceSplit, WorkspaceTab, WorkspaceTabKind } from '@shared/workspace'
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
  applyLayout,
  closeWorkspaceView,
  closeWorkspaceGroup,
  closeWorkspaceTab,
  createWorkspaceView,
  dropSessionInGroup,
  createThreadInGroup,
  focusWorkspaceGroup,
  loadMessages,
  loadTodos,
  renameWorkspaceView,
  reorderWorkspaceTab,
  moveWorkspaceTabToNewView,
  renameWorkspaceTab,
  sendWorkspaceTabToView,
  setNativeViewsSuspended,
  setWorkspaceSplitRatio,
  splitWorkspaceGroup,
  ensurePanel,
  undoWorkspaceChange
} from '../lib/actions'
import { SESSION_DRAG_TYPE, TAB_DRAG_TYPE, activeWorkspaceView, conversationGroupId, panelGroupId, findGroup, findSessionTab, threadCheckout, walkGroups, walkTabs, workspaceMenuRight } from '../lib/workspaces'
import { tabContentNode } from '../lib/tab-content-nodes'
import { BACKEND_MARKS, BackIcon, ChatIcon, ChevronIcon, FilesIcon, GlobeIcon, PanelIcon, PlusIcon, RenameIcon, ReviewIcon, TerminalIcon, TrashIcon } from './icons'
import { BackendBadge } from './BackendControls'
import { BACKEND_SHORT_LABELS } from '../lib/backend-labels'


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

/** The mark for a thread's own tab: its backend rather than the generic chat
 *  bubble. Every thread drew the same bubble, so the slot said nothing while
 *  the backend rode beside the title as a text pill that never shrank. The
 *  pill cost about 55px of a 92px tab, which is why the titles were unreadable.
 *  A resource keeps its kind icon — it has no backend of its own. */
function tabMark(item: WorkspaceTab, backendId?: string): (props: { size?: number }) => React.JSX.Element {
  if (item.kind === 'thread' && backendId && BACKEND_MARKS[backendId]) return BACKEND_MARKS[backendId]
  return tabIcon(item.kind)
}

function isLiveSurface(item: WorkspaceTab): boolean {
  return item.kind === 'browser' || item.kind === 'terminal'
}

function requestCloseWorkspaceTab(groupId: string, item: WorkspaceTab): void {
  const state = appStore.getState()
  const busy = item.kind === 'thread' && item.sessionId
    && (state.sessionBusy[item.sessionId] || state.streaming[item.sessionId])

  if (busy) {
    const title = state.sessions.find((session) => session.id === item.sessionId)?.title || 'This thread'
    appStore.setState({
      confirm: {
        title: 'Close while it is working?',
        message: `${title} is still working. Closing it here stops you seeing the rest of the run.`,
        confirmLabel: 'Close anyway',
        destructive: true,
        action: () => closeWorkspaceTab(groupId, item.id)
      }
    })
    return
  }

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

/** Threads in this pane whose agent is mid-run. Closing disposes what it
 *  removes, so a working agent is worth stopping for even though a terminal
 *  is not the only live thing in the pane. */
function workingThreads(group: WorkspaceGroup): string[] {
  const state = appStore.getState()
  return group.tabs
    .filter((item) => item.kind === 'thread' && item.sessionId)
    .filter((item) => state.sessionBusy[item.sessionId!] || state.streaming[item.sessionId!])
    .map((item) => state.sessions.find((session) => session.id === item.sessionId)?.title || 'Untitled')
}

function requestCloseWorkspaceGroup(group: WorkspaceGroup): void {
  const terminals = group.tabs.filter((item) => item.kind === 'terminal').length
  const working = workingThreads(group)
  if (terminals === 0 && working.length === 0) {
    closeWorkspaceGroup(group.id)
    return
  }

  const parts: string[] = []
  if (working.length === 1) parts.push(`${working[0]} is still working.`)
  else if (working.length > 1) parts.push(`${working.length} threads are still working.`)
  if (terminals === 1) parts.push('This closes the terminal and ends its running shell and processes.')
  else if (terminals > 1) parts.push(`This closes ${terminals} terminals and ends their running shells and processes.`)

  appStore.setState({
    confirm: {
      title: working.length ? 'Close pane while it is working?' : 'Close pane?',
      message: parts.join(' '),
      confirmLabel: 'Close pane',
      destructive: true,
      action: () => closeWorkspaceGroup(group.id)
    }
  })
}

/** The same name useTabLabel derives, for places that cannot call a hook —
 *  chiefly filtering a list of tabs. Reads the store directly instead. */
function tabSearchLabel(item: WorkspaceTab): string {
  const state = appStore.getState()
  if (item.title && item.kind !== 'thread') return item.title
  if (item.kind === 'thread') {
    return state.sessions.find((session) => session.id === item.sessionId)?.title || 'Untitled thread'
  }
  if (item.kind === 'browser') {
    const title = state.browse[`workspace-${item.id}`]?.title
    if (title) return title
  }
  return TAB_TYPES.find((candidate) => candidate.kind === item.kind)?.label ?? item.kind
}

function useTabLabel(item: WorkspaceTab, group: WorkspaceGroup): string {
  const sessionTitle = useStore(appStore, (state) => state.sessions.find((session) => session.id === item.sessionId)?.title)
  const browserTitle = useStore(appStore, (state) => state.browse[`workspace-${item.id}`]?.title)
  const authBackendId = useStore(appStore, (state) => state.authTerminalBackends?.[item.id])
  const sameKindIndex = group.tabs.filter((candidate) => candidate.kind === item.kind).findIndex((candidate) => candidate.id === item.id)
  const suffix = sameKindIndex > 0 ? ` ${sameKindIndex + 1}` : ''
  // A name the user gave it wins over anything derived. Threads are named by
  // their session, so they ignore this.
  if (item.title && item.kind !== 'thread') return item.title
  if (item.kind === 'thread') return sessionTitle || 'Untitled thread'
  if (item.kind === 'browser') return browserTitle || `Browser${suffix}`
  if (item.kind === 'terminal' && authBackendId) {
    return `Connect ${BACKEND_SHORT_LABELS[authBackendId]}`
  }
  // No checkout on the label. A resource inherits its thread's, so naming it
  // here repeated what the pane already said; when the resource sits away from
  // its thread, the origin badge names the thread instead, which is the part
  // that is actually in doubt.
  return `${TAB_TYPES.find((candidate) => candidate.kind === item.kind)?.label ?? item.kind}${suffix}`
}

interface TabOrigin {
  title: string
  viewId: string
  groupId: string
  tabId: string
}

/** Where a resource's thread is, when the thread is not in this pane.
 *
 *  A resource can be dragged anywhere and keeps running against its own
 *  checkout, so once it sits away from its thread this is the only thing that
 *  can say what it belongs to. */
function originOf(item: WorkspaceTab, group: WorkspaceGroup, workspace: WorkspaceState | null, title?: string): TabOrigin | null {
  if (item.kind === 'thread' || !item.sessionId || !workspace) return null
  if (group.tabs.some((candidate) => candidate.kind === 'thread' && candidate.sessionId === item.sessionId)) return null
  for (const view of workspace.views) {
    const found = findSessionTab(view.root, item.sessionId)
    if (found) return { title: title || 'its thread', viewId: view.id, groupId: found.group.id, tabId: found.tab.id }
  }
  return null
}

function TabLabel({ item, group }: { item: WorkspaceTab; group: WorkspaceGroup }): React.JSX.Element {
  const label = useTabLabel(item, group)
  // A chat belongs to no project, so it owns no resources and shows no branch.
  // Marking the tab says why its + is missing before anyone goes looking.
  const isChat = useStore(appStore, (state) => {
    if (item.kind !== 'thread' || !item.sessionId) return false
    const session = state.sessions.find((candidate) => candidate.id === item.sessionId)
    return Boolean(session) && !(session?.projectPath ?? session?.directory ?? session?.path)
  })
  const backendId = useStore(appStore, (state) => state.sessions.find((session) => session.id === item.sessionId)?.backendId)
  const Icon = tabMark(item, backendId)
  const busy = useStore(appStore, (state) => Boolean(item.sessionId && state.streaming[item.sessionId]))
  const permission = useStore(appStore, (state) => Boolean(item.sessionId && state.permissions[item.sessionId]))
  const failed = useStore(appStore, (state) => Boolean(item.sessionId && state.lastErrorBySession[item.sessionId]))
  const busActivity = useStore(appStore, (state) => Boolean(item.sessionId && state.threadBus?.messages.some((message) =>
    (message.fromThreadId === item.sessionId || message.toThreadId === item.sessionId) && message.status !== 'delivered'
  )))
  // An agent drove this browser while you were elsewhere. Same treatment as a
  // working thread, since it is the same thing: work happening out of sight.
  const agentDrove = useStore(appStore, (state) =>
    item.kind === 'browser' && Boolean(state.browseAgentActivity[`workspace-${item.id}`])
  )

  return (
    <>
      <span
        className={`workspace-tab-icon ${item.kind === 'thread' && backendId ? `backend-${backendId}` : ''} ${busy || agentDrove ? 'working' : ''} ${permission ? 'attention' : ''} ${failed ? 'failed' : ''}`}
      >
        <Icon size={16} />
      </span>
      <span className={`workspace-tab-label ${isChat ? 'chat' : ''}`} title={isChat ? `${label} — a chat, with no project or checkout` : label}>
        {label}
      </span>
      {isChat ? <span className="workspace-tab-chat">Chat</span> : null}
      {busActivity ? <span className="workspace-tab-bus" title="Thread message queued or failed" /> : null}
    </>
  )
}

/** Says which tab this menu belongs to.
 *
 *  The tab strip cannot: at its narrowest a title is an ellipsis, and the
 *  backend is a 13px mark. Four threads on one backend were indistinguishable,
 *  which is the reason the menu exists at all, so the full title, the spelled
 *  out backend and the checkout all go here. */
function TabMenuHeader({ item, group }: { item: WorkspaceTab; group: WorkspaceGroup }): React.JSX.Element {
  const label = useTabLabel(item, group)
  const backendId = useStore(appStore, (state) => state.sessions.find((session) => session.id === item.sessionId)?.backendId)
  const checkout = useStore(appStore, (state) => {
    if (item.contextLabel) return item.contextLabel
    const session = state.sessions.find((candidate) => candidate.id === item.sessionId)
    return session ? threadCheckout(session)?.contextLabel : undefined
  })
  const project = useStore(appStore, (state) => {
    const session = state.sessions.find((candidate) => candidate.id === item.sessionId)
    const path = session?.projectPath ?? session?.directory ?? session?.path
    return path ? path.split('/').filter(Boolean).pop() : undefined
  })
  const kind = TAB_TYPES.find((candidate) => candidate.kind === item.kind)?.label ?? item.kind
  const Icon = tabMark(item, backendId)
  return (
    <div className="workspace-tab-menu-header">
      <div className="workspace-tab-menu-title">
        <span className={`workspace-tab-icon ${item.kind === 'thread' && backendId ? `backend-${backendId}` : ''}`}>
          <Icon size={16} />
        </span>
        <strong>{label}</strong>
      </div>
      <div className="workspace-tab-menu-meta">
        <span>{item.kind === 'thread' && backendId ? BACKEND_SHORT_LABELS[backendId] : kind}</span>
        {project ? <span>{project}</span> : null}
        {checkout ? <span>{checkout}</span> : null}
      </div>
    </div>
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

function AddMenu({
  groupId,
  ownerId: requested,
  close
}: {
  groupId: string
  /** The thread whose own + was used, when it was one. */
  ownerId?: string
  close: () => void
}): React.JSX.Element {
  const sessions = useStore(appStore, (state) => state.sessions)
  const workspace = useStore(appStore, (state) => state.projectWorkspace)
  // Subscribed, not read from getState: the menu has to rebuild when the layout
  // setting changes, and a value read inside the memo cannot trigger that.
  const viewMode = useStore(appStore, (state) => state.viewMode)

  // A resource belongs to the thread it was opened from, so it takes that
  // thread's checkout — including its worktree — rather than asking. No
  // fallback to the active session: an empty pane would silently bind its
  // files to whatever thread happened to be selected somewhere else.
  const ownerId = useMemo(() => {
    if (requested) return requested
    if (!workspace) return undefined
    const view = activeWorkspaceView(workspace)
    const pane = findGroup(view.root, groupId)
    if (!pane) return undefined
    // The thread you are looking at, not the first one in the pane. A pane can
    // hold several, and taking the leftmost bound a review to whichever thread
    // happened to be furthest left rather than the open one.
    const active = pane.tabs.find((item) => item.id === pane.activeTabId)
    if (active?.kind === 'thread' && active.sessionId) return active.sessionId
    const own = pane.tabs.find((item) => item.kind === 'thread')?.sessionId
    if (own) return own
    // In single mode the panel holds no thread of its own — the conversation
    // beside it does, and everything in the panel belongs to that thread.
    // Without this the panel could only ever offer "start a thread".
    if (viewMode !== 'single') return undefined
    const conversation = findGroup(view.root, conversationGroupId(view))
    return conversation?.tabs.find((item) => item.kind === 'thread')?.sessionId
  }, [workspace, groupId, requested, viewMode])
  const owner = sessions.find((session) => session.id === ownerId)
  const inherited = threadCheckout(owner)

  const hasThread = Boolean(owner)

  // Nothing to attach a resource to yet. A terminal needs a checkout and a
  // diff needs something to diff, so an empty pane offers threads only.
  if (!hasThread) {
    return (
      <div className="workspace-add-menu">
        <div className="workspace-menu-title">Start a thread</div>
        <NewThreadButtons groupId={groupId} close={close} />
        <div className="workspace-menu-note">
          Or drag a thread here from the sidebar. Terminals, files and reviews
          are added to a thread once it has one.
        </div>
      </div>
    )
  }

  const resources = TAB_TYPES.filter((item) => item.kind !== 'thread')

  return (
    <div className="workspace-add-menu">
      <div className="workspace-menu-title">Add to {owner?.title || 'this thread'}</div>
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
  viewShowing
}: {
  groupId: string
  item: WorkspaceTab
  active: boolean
  /** False while this tab's whole view is hidden. Browsers are a native view
   *  each, so they detach rather than composite behind a hidden panel. The
   *  page keeps running; only the expensive part stops. Menus opening over a
   *  pane are handled by setNativeViewsSuspended instead, which is global and
   *  no longer reachable from here. */
  viewShowing: boolean
}): React.JSX.Element | null {
  const authBackendId = useStore(appStore, (state) => state.authTerminalBackends?.[item.id])
  useEffect(() => {
    if (item.kind !== 'thread' || !item.sessionId) return
    void loadMessages(item.sessionId)
    void loadTodos(item.sessionId)
  }, [item.kind, item.sessionId])

  let content: React.JSX.Element
  switch (item.kind) {
    case 'thread':
      content = item.sessionId ? <ChatView sessionId={item.sessionId} active={active && viewShowing} /> : <div className="workspace-unbound">Choose a thread for this tab.</div>
      break
    case 'browser':
      content = <BrowseTab id={`workspace-${item.id}`} visible={active && viewShowing} />
      break
    case 'terminal':
      content = (
        <TerminalTab
          tabId={item.id}
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
  // Portalled into its pane rather than rendered inside it. React reconciles
  // by position, so a tab moving between panes used to unmount and remount —
  // and unmounting a terminal disposes its shell, a browser its page. Kept in
  // one list at the workspace root, the component never moves in the React
  // tree however far the tab travels; only the DOM container changes.
  // Portalled into a node this tab owns, which is then moved into whichever
  // pane is showing it. Portalling straight at the pane looked equivalent, but
  // a portal aimed at a new container rebuilds its DOM rather than moving it,
  // so every change of pane remounted the content and lost what it held.
  //
  // Moving the node keeps it: appendChild relocates a live element, with its
  // scroll, focus and selection. This is what TerminalTab already does with
  // xterm's element, which is why a terminal survives what a files tab did not.
  const node = tabContentNode(item.id)
  const host = useTabHost(item.id)

  useEffect(() => {
    if (!host) return
    if (node.parentElement !== host) {
      // Moving an element blurs whatever inside it had focus, so a search box
      // or an editor loses the caret on a drag. Selection survives on its own;
      // focus has to be put back.
      const focused = document.activeElement
      const hadFocus = focused instanceof HTMLElement && node.contains(focused)
      host.appendChild(node)
      if (hadFocus) (focused as HTMLElement).focus({ preventScroll: true })
    }
    // The slot carries hidden, not the content: slots are siblings in one pane,
    // so an inactive one has to take no space rather than sit there holding a
    // hidden child.
    host.hidden = !active
  }, [host, node, active])

  return createPortal(content, node)
}

/** Where each tab's content is painted, published by the pane that owns it.
 *
 *  The map lives in a ref, not in state. A ref callback fires on every render
 *  — null, then the element — so writing state from one re-renders, which
 *  fires the callback again, which writes state again: "Maximum update depth
 *  exceeded". Instead the map mutates silently and a single version counter
 *  tells the content it has somewhere new to go. */
const TabSlots = React.createContext<{
  slots: React.MutableRefObject<Map<string, HTMLElement>>
  publish: (tabId: string, element: HTMLElement | null, previous?: HTMLElement | null) => void
  version: number
}>({ slots: { current: new Map() }, publish: () => {}, version: 0 })

function useTabHost(tabId: string): HTMLElement | null {
  const { slots, version } = React.useContext(TabSlots)
  // version is read so this recomputes when a slot arrives or leaves.
  void version
  return slots.current.get(tabId) ?? null
}

/** The empty div a tab's content is portalled into. One per tab, rendered by
 *  the pane, so the pane still controls layout while the content itself stays
 *  put in the React tree. */
function TabSlot({ tabId }: { tabId: string }): React.JSX.Element {
  const { publish } = React.useContext(TabSlots)
  // The slot remembers its own element so a detach can say which one is going.
  const mine = useRef<HTMLElement | null>(null)
  const attach = React.useCallback(
    (element: HTMLElement | null) => {
      const previous = mine.current
      mine.current = element
      publish(tabId, element, previous)
    },
    [publish, tabId]
  )
  return <div className="workspace-tab-slot" data-tab-slot={tabId} ref={attach} />
}

function TabSlotProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const slots = useRef(new Map<string, HTMLElement>())
  const [version, setVersion] = useState(0)
  const publish = React.useCallback((tabId: string, element: HTMLElement | null, previous?: HTMLElement | null) => {
    const current = slots.current.get(tabId)
    if (element === (current ?? null)) return
    // A tab moving pane detaches its old slot and attaches a new one, and React
    // runs the cleanup first. Clearing on any detach left the tab with no host
    // in between, so its content unmounted and lost everything it held — a
    // files tab lost its open files and scroll. A detach only clears the entry
    // if that slot still owns it.
    if (!element && previous && current !== previous) return
    if (element) slots.current.set(tabId, element)
    else slots.current.delete(tabId)
    // Only when the set of slots actually changed, so a re-render that hands
    // back the same element does not start the loop again.
    setVersion((count) => count + 1)
  }, [])
  const value = useMemo(() => ({ slots, publish, version }), [publish, version])
  return <TabSlots.Provider value={value}>{children}</TabSlots.Provider>
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

/** A pane and its tab strip.
 *
 *  `single` is set when the workspace is showing one thread at a time. The pane
 *  is then the whole surface, so the things that only mean something beside
 *  another pane — splitting, and dropping to one side — are suppressed. Tabs
 *  themselves work exactly as they do in tiling. */
function GroupView({ group, viewId, conversation = false, panel = false }: {
  group: WorkspaceGroup
  viewId: string
  /** The pane beside the conversation in single mode. It is created by the bar
   *  button rather than by the user, so it must not greet them with a menu. */
  panel?: boolean
  /** The pane that holds the thread itself in single mode. Its tab is the
   *  thread, so it stays one pane and its strip is not worth drawing. */
  conversation?: boolean
}): React.JSX.Element {
  const workspace = useStore(appStore, (state) => state.projectWorkspace)
  const highlightedTabId = useStore(appStore, (state) => state.highlightedTabId)
  // The view this pane is in, not whichever is on screen: every view stays
  // mounted, so a hidden one must not read the active view's focus.
  const view = workspace?.views.find((item) => item.id === viewId) ?? null
  const focused = view?.focusedGroupId === group.id && workspace?.activeViewId === viewId
  const arrived = Boolean(highlightedTabId && group.tabs.some((item) => item.id === highlightedTabId))
  const sessions = useStore(appStore, (state) => state.sessions)
  // A chat has no project, so there is no checkout to hand a terminal.
  const ownsCheckout = (sessionId: string): boolean => {
    const session = sessions.find((candidate) => candidate.id === sessionId)
    return Boolean(session && (session.projectPath ?? session.directory ?? session.path))
  }
  const movable = Boolean(view && walkTabs(view.root).length > 1)
  // An empty pane opens its own add menu, which is right when the user made the
  // pane. Single mode's panel is created for them by the bar button, which is
  // opening its own menu at that moment — so the panel would show two.
  const [menuOpen, setMenuOpen] = useState(group.tabs.length === 0 && !panel)
  const [menuRight, setMenuRight] = useState<number | null>(null)
  /** Set when the menu was opened from one thread's own + rather than the
   *  pane's, so it adds to that thread rather than whichever the pane shows. */
  const [menuOwnerId, setMenuOwnerId] = useState<string | undefined>(undefined)
  const [dropTarget, setDropTarget] = useState<DropPosition | null>(null)
  const [tabMenu, setTabMenu] = useState<{ tabId: string; x: number; y: number } | null>(null)
  const [overflowOpen, setOverflowOpen] = useState(false)
  const [overflow, setOverflow] = useState(0)
  const [filter, setFilter] = useState('')
  const tabsRef = useRef<HTMLDivElement>(null)
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
    if (!tabMenu) return
    // Only a click outside. It used to dismiss on any click, which was safe
    // when the one item navigated away; it now closes tabs, so a click landing
    // on the menu has to reach the button under it.
    const close = (event: MouseEvent): void => {
      if (!(event.target as HTMLElement)?.closest('.workspace-tab-menu')) setTabMenu(null)
    }
    const key = (event: KeyboardEvent): void => { if (event.key === 'Escape') setTabMenu(null) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', key)
    }
  }, [tabMenu])

  // How many tabs the strip cannot show. Measured rather than counted: the
  // pane's width decides it, and splitting a pane changes that without
  // changing the tabs.
  useEffect(() => {
    const strip = tabsRef.current
    if (!strip) return
    const measure = (): void => {
      const bounds = strip.getBoundingClientRect()
      const hidden = Array.from(strip.querySelectorAll<HTMLElement>('.workspace-tab')).filter((node: HTMLElement) => {
        const rect = node.getBoundingClientRect()
        return rect.right > bounds.right + 1 || rect.left < bounds.left - 1
      })
      setOverflow(hidden.length)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(strip)
    strip.addEventListener('scroll', measure)
    return () => {
      observer.disconnect()
      strip.removeEventListener('scroll', measure)
    }
  }, [group.tabs.length])

  useEffect(() => {
    if (!overflowOpen) { setFilter(''); return }
    const close = (event: MouseEvent): void => {
      if (!(event.target as HTMLElement)?.closest('.workspace-tab-overflow-menu, .workspace-tab-overflow')) {
        setOverflowOpen(false)
      }
    }
    const key = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOverflowOpen(false) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', key)
    }
  }, [overflowOpen])

  // Browsers are native views composited over the page, so any menu drawn
  // while one is showing would sit underneath it and take no clicks. Detach
  // them for as long as a menu is open.
  useEffect(() => {
    const reason = `workspace-group-${group.id}`
    const suspended = menuOpen || Boolean(dropTarget) || Boolean(tabMenu) || overflowOpen
    setNativeViewsSuspended(reason, suspended)
    return () => setNativeViewsSuspended(reason, false)
  }, [group.id, menuOpen, dropTarget, tabMenu, overflowOpen])

  // A drag can end anywhere, including over a native view or outside the
  // window, so dragleave is not guaranteed. Clearing on the global dragend
  // stops the drop indicator from sticking after the drag is over.
  useEffect(() => {
    if (!dropTarget) return
    const clear = (): void => setDropTarget(null)
    document.addEventListener('dragend', clear)
    document.addEventListener('drop', clear)
    return () => {
      document.removeEventListener('dragend', clear)
      document.removeEventListener('drop', clear)
    }
  }, [dropTarget])

  const onDrop = (event: React.DragEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    if (!view) return
    // The conversation pane is the thread and stays one pane, so a side drop
    // there would split what single mode exists to keep whole. The panel splits
    // like any other.
    const position = conversation ? 'center' : (dropTarget ?? 'center')
    // Two payloads land here. A tab drag moves something that already exists,
    // possibly out of another view. A session drag carries a thread that may
    // not be open at all, which is how an empty pane gets filled.
    const tabId = event.dataTransfer.getData(TAB_DRAG_TYPE)
    const sessionId = event.dataTransfer.getData(SESSION_DRAG_TYPE)
    if (tabId) sendWorkspaceTabToView(tabId, view.id, group.id, position)
    else if (sessionId) dropSessionInGroup(sessionId, view.id, group.id, position)
    setDropTarget(null)
  }

  return (
    <section
      className={`workspace-group ${focused ? 'focused' : ''} ${arrived ? 'arrived' : ''} ${menuRight !== null ? 'menu-anchored' : ''}`}
      style={{ '--workspace-add-menu-right': `${menuRight ?? 8}px` } as React.CSSProperties}
      data-workspace-group={group.id}
      onMouseDown={() => focusWorkspaceGroup(group.id)}
      onDragOver={(event) => {
        // Only types is readable here: the drag data store is protected until
        // drop, so getData returns "" during dragover. The old guard against
        // dropping a lone tab back into its own pane read getData, so it never
        // fired; moveTab already treats that as a no-op.
        const types = event.dataTransfer.types
        if (!types.includes(TAB_DRAG_TYPE) && !types.includes(SESSION_DRAG_TYPE)) return
        event.preventDefault()
        setDropTarget(conversation ? 'center' : dropPosition(event, event.currentTarget))
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null)
      }}
      onDrop={onDrop}
    >
      {/* The conversation pane has one tab and it is the thread, so its strip
          says nothing the bar does not already say. */}
      <header className="workspace-group-tabs" hidden={conversation}>
        <div className="workspace-tabs" role="tablist" ref={tabsRef}>
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
              // Every kind, not just resources. Once tabs are narrow the label
              // is an ellipsis and the hover controls are a few pixels wide, so
              // this is the one target that does not shrink: it says what the
              // tab is and closes it without a precise click.
              onContextMenu={(event) => {
                event.preventDefault()
                event.stopPropagation()
                setTabMenu({ tabId: item.id, x: event.clientX, y: event.clientY })
              }}
            >
              <TabLabel item={item} group={group} />
              {/* On the thread's own tab, so "add to this thread" needs no
                  explaining. A resource tab owns nothing, and a chat has no
                  checkout to give, so neither gets one. */}
              {item.kind === 'thread' && item.sessionId && ownsCheckout(item.sessionId) ? (
                <span
                  className="workspace-tab-add-inline"
                  role="button"
                  title="Add a terminal, files or review to this thread"
                  onClick={(event) => {
                    event.stopPropagation()
                    const trigger = event.currentTarget.getBoundingClientRect()
                    const container = event.currentTarget.closest('.workspace-group')?.getBoundingClientRect()
                    setMenuRight(container ? workspaceMenuRight(trigger.right, container.left, container.right) : 8)
                    // This + sits on one thread's tab and says it adds to that
                    // thread, so it names it rather than letting the menu pick.
                    setMenuOwnerId(item.sessionId)
                    setMenuOpen(true)
                  }}
                >
                  <PlusIcon size={11} />
                </span>
              ) : null}
              {/* Holds what would be dangerous as a stray click on the tab
                  itself. Threads have no elsewhere to be, so they skip it. */}
              {item.kind !== 'thread' && item.sessionId ? (
                <span
                  className="workspace-tab-more"
                  role="button"
                  title="More"
                  // On mousedown, and stopped, so the dismiss listener does not
                  // close the menu in the same gesture that opens it.
                  onMouseDown={(event) => {
                    event.stopPropagation()
                    const trigger = event.currentTarget.getBoundingClientRect()
                    setTabMenu(tabMenu?.tabId === item.id ? null : { tabId: item.id, x: trigger.right, y: trigger.bottom })
                  }}
                  onClick={(event) => event.stopPropagation()}
                >⋯</span>
              ) : null}
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
          {/* Only for a pane with nothing in it. Once a thread is here, its own
              tab carries the +, so this one would just be a second way in. */}
          {group.tabs.length === 0 ? (
            <button
              ref={addButtonRef}
              className="workspace-tab-add"
              title="Add a thread"
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
          ) : null}
        </div>
        {/* Reaches the tabs the strip had to scroll away. Without it a crowded
            pane hid tabs behind a scrollbar that is deliberately invisible. */}
        {overflow > 0 ? (
          <button
            className="workspace-tab-overflow"
            title={`${overflow} more ${overflow === 1 ? 'tab' : 'tabs'}`}
            onClick={(event) => {
              event.stopPropagation()
              setOverflowOpen((open) => !open)
            }}
          >
            <ChevronIcon size={11} className="workspace-bar-caret" />
            <span>{overflow}</span>
          </button>
        ) : null}
        <div className="workspace-group-actions">
          {conversation ? null : (
            <>
              <button onClick={() => splitWorkspaceGroup(group.id, 'horizontal')} title="Split left and right">↔</button>
              <button onClick={() => splitWorkspaceGroup(group.id, 'vertical')} title="Split top and bottom">↕</button>
            </>
          )}
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
            <span>Drag a thread here, or start one</span>
            <small>Terminals, files and reviews belong to a thread, so they come later.</small>
          </button>
        ) : null}
        {/* Slots only, and empty ones: each tab owns its content node and that
            node is moved in here. The component behind it never moves in the
            React tree, and the DOM it built is relocated rather than rebuilt. */}
        {group.tabs.map((item) => <TabSlot key={item.id} tabId={item.id} />)}
      </div>

      {menuOpen ? <div ref={menuRef}><AddMenu groupId={group.id} ownerId={menuOwnerId} close={() => setMenuOpen(false)} /></div> : null}
      {tabMenu ? (() => {
        const item = group.tabs.find((candidate) => candidate.id === tabMenu.tabId)
        if (!item) return null
        const title = sessions.find((session) => session.id === item.sessionId)?.title
        const origin = originOf(item, group, workspace ?? null, title)
        const otherViews = (workspace?.views ?? []).filter((candidate) => candidate.id !== viewId)
        return (
          <div
            className="workspace-tab-menu"
            style={{ left: tabMenu.x, top: tabMenu.y }}
            // The dismiss listener is on mousedown, which fires before click,
            // so without this the menu closed before its own buttons ran.
            onMouseDown={(event) => event.stopPropagation()}
          >
            {/* What the tab itself can no longer say. A narrow tab shows an
                ellipsis and four threads on one backend look alike, so the
                full title, the backend and the checkout go here. */}
            <TabMenuHeader item={item} group={group} />
            {origin ? (
              <button
                className="workspace-add-menu-item"
                onClick={() => {
                  setTabMenu(null)
                  sendWorkspaceTabToView(item.id, origin.viewId, origin.groupId)
                }}
              >
                <BackIcon size={13} />
                <span>Send back to {origin.title}</span>
              </button>
            ) : null}
            <button
              className="workspace-add-menu-item"
              onClick={() => {
                setTabMenu(null)
                moveWorkspaceTabToNewView(item.id)
              }}
            >
              <PanelIcon size={13} />
              <span>Move to a new view</span>
            </button>
            {otherViews.length ? (
              <div className="workspace-tab-menu-section">
                <div className="workspace-tab-menu-heading">Move to view</div>
                {otherViews.map((target) => (
                  <button
                    key={target.id}
                    className="workspace-add-menu-item"
                    onClick={() => {
                      setTabMenu(null)
                      const landing = walkGroups(target.root)[0]
                      if (landing) sendWorkspaceTabToView(item.id, target.id, landing.id)
                    }}
                  >
                    <PanelIcon size={13} />
                    <span>{target.name}</span>
                  </button>
                ))}
              </div>
            ) : null}
            {/* Threads take their name from the session, so renaming one here
                would be overwritten the moment the session is renamed. */}
            {item.kind !== 'thread' ? (
              <button
                className="workspace-add-menu-item"
                onClick={() => {
                  const current = item.title ?? ''
                  const next = window.prompt('Name this tab', current)
                  setTabMenu(null)
                  if (next !== null) renameWorkspaceTab(item.id, next)
                }}
              >
                <RenameIcon size={13} />
                <span>Rename</span>
              </button>
            ) : null}
            <button
              className="workspace-add-menu-item destructive"
              onClick={() => {
                setTabMenu(null)
                requestCloseWorkspaceTab(group.id, item)
              }}
            >
              <TrashIcon size={13} />
              <span>{isLiveSurface(item) ? `Close ${item.kind}` : 'Hide this surface'}</span>
            </button>
          </div>
        )
      })() : null}
      {overflowOpen ? (
        <div className="workspace-tab-overflow-menu" onMouseDown={(event) => event.stopPropagation()}>
          <input
            className="workspace-tab-overflow-filter"
            placeholder="Filter tabs"
            value={filter}
            autoFocus
            onChange={(event) => setFilter(event.target.value)}
          />
          <div className="workspace-tab-overflow-list">
            {group.tabs.map((item) => ({ item, label: tabSearchLabel(item) }))
              .filter(({ label }) => label.toLowerCase().includes(filter.trim().toLowerCase()))
              .map(({ item }) => (
                <div key={item.id} className={`workspace-tab-overflow-row ${item.id === activeId ? 'active' : ''}`}>
                  <button
                    className="workspace-tab-overflow-pick"
                    onClick={() => {
                      setOverflowOpen(false)
                      activateWorkspaceTab(group.id, item.id)
                    }}
                  >
                    <TabLabel item={item} group={group} />
                  </button>
                  <span
                    className={`workspace-tab-close ${isLiveSurface(item) ? 'destructive' : ''}`}
                    role="button"
                    title={isLiveSurface(item) ? `Close ${item.kind}` : 'Hide this surface'}
                    onClick={(event) => {
                      event.stopPropagation()
                      requestCloseWorkspaceTab(group.id, item)
                    }}
                  >{isLiveSurface(item) ? '×' : '−'}</span>
                </div>
              ))}
          </div>
        </div>
      ) : null}
      {dropTarget ? <div className={`workspace-drop-target ${dropTarget}`}><span>{dropTarget === 'center' ? 'Move into pane' : `Split ${dropTarget}`}</span></div> : null}
    </section>
  )
}

function SplitView({ node, viewId, single = false, conversationId }: {
  node: WorkspaceSplit
  viewId: string
  single?: boolean
  conversationId?: string
}): React.JSX.Element {
  // An empty panel takes no room, so a thread with nothing attached reads as
  // one conversation filling the window rather than a blank half.
  const emptySecond = single && node.second.type === 'group' && node.second.tabs.length === 0
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
      {/* Keyed by node id, and the wrappers too. Closing a pane collapses a
          split into the pane beside it, so every surviving node moves up a
          level. Reconciled by position React saw a different component at each
          slot and rebuilt the subtree, which recreates the slot a tab portals
          into: a files tab in an untouched pane lost its open files, its
          expanded folders and its scroll. */}
      {/* In single mode the shown pane takes the whole split and the ratio is
          ignored, so the one visible pane fills the window rather than keeping
          the width it happened to have in the layout. */}
      <div
        key={node.first.id}
        className="workspace-split-child"
        style={{ flexBasis: emptySecond ? '100%' : `${node.ratio * 100}%` }}
      >
        <WorkspaceNodeView node={node.first} viewId={viewId} single={single} conversationId={conversationId} />
      </div>
      <div key={`splitter-${node.id}`} className="workspace-splitter" onMouseDown={onMouseDown} hidden={emptySecond} />
      <div
        key={node.second.id}
        className="workspace-split-child"
        style={{ flexBasis: emptySecond ? '0%' : `${(1 - node.ratio) * 100}%` }}
        hidden={emptySecond}
      >
        <WorkspaceNodeView node={node.second} viewId={viewId} single={single} conversationId={conversationId} />
      </div>
    </div>
  )
}

function WorkspaceNodeView({ node, viewId, single = false, conversationId }: {
  node: WorkspaceNode
  viewId: string
  single?: boolean
  conversationId?: string
}): React.JSX.Element {
  if (node.type === 'group') {
    return (
      <div className="workspace-node">
        <GroupView
          key={node.id}
          group={node}
          viewId={viewId}
          conversation={single && node.id === conversationId}
          panel={single && node.id !== conversationId}
        />
      </div>
    )
  }
  return <SplitView key={node.id} node={node} viewId={viewId} single={single} conversationId={conversationId} />
}

/** Bar controls for single mode: what thread is on screen, and a way to put
 *  something beside it.
 *
 *  The panel is an ordinary pane, so adding to it is the same AddMenu every
 *  other pane uses — this just aims it at the panel group rather than at
 *  whichever pane happens to be focused. */
/** The thread on screen, named at the left of the bar. */
function SingleThreadTitle(): React.JSX.Element | null {
  const workspace = useStore(appStore, (state) => state.projectWorkspace)
  const sessions = useStore(appStore, (state) => state.sessions)
  const view = workspace?.views.find((item) => item.id === workspace.activeViewId)
  if (!view) return null
  const conversation = walkGroups(view.root).find((item) => item.id === conversationGroupId(view))
  const sessionId = conversation?.tabs.find((item) => item.kind === 'thread')?.sessionId
  const session = sessions.find((item) => item.id === sessionId)
  const branch = session?.worktree?.status === 'active' ? session.worktree.branch : undefined
  const where = branch ?? (session?.projectPath ? session.projectPath.split(/[\\/]/).pop() : undefined)
  return (
    <div className="workspace-single-title">
      <strong>{session?.title || view.name}</strong>
      {where ? <small>{where}</small> : null}
    </div>
  )
}

/** The panel control, at the right of the bar where the layout controls sit in
 *  multi mode. Separate from the title so the spacer can sit between them. */
function SinglePanelButton(): React.JSX.Element | null {
  const workspace = useStore(appStore, (state) => state.projectWorkspace)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const away = (event: MouseEvent): void => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])

  const view = workspace?.views.find((item) => item.id === workspace.activeViewId)
  if (!view) return null
  const groups = walkGroups(view.root)
  const conversationId = conversationGroupId(view)
  const conversation = groups.find((item) => item.id === conversationId) ?? groups[0]
  // May be missing on a view carried over from tiling. The button still shows:
  // choosing something is what creates the panel.
  const panelId = panelGroupId(view)
  const panelGroup = panelId ? groups.find((item) => item.id === panelId) : undefined
  const panelHasTabs = (panelGroup?.tabs.length ?? 0) > 0
  const sessionId = conversation.tabs.find((item) => item.kind === 'thread')?.sessionId

  return (
    <>
      <div className="workspace-single-panel-control" ref={ref}>
        <button
          className={`workspace-bar-button ${open ? 'active' : ''}`}
          onClick={() => {
            // With something in the panel the button is a toggle: hide what is
            // there rather than offering to add more. Only an empty panel opens
            // the menu, which is the only time "add" is the obvious intent.
            if (panelHasTabs && panelGroup) {
              requestCloseWorkspaceGroup(panelGroup)
              return
            }
            if (!panelId) ensurePanel(view.id)
            setOpen((value) => !value)
          }}
          title={panelHasTabs ? 'Close the panel' : 'Open a terminal, browser, files, or a side chat beside this thread'}
        >
          <PanelIcon size={13} />
        </button>
        {open && panelId ? <AddMenu groupId={panelId} ownerId={sessionId} close={() => setOpen(false)} /> : null}
      </div>
    </>
  )
}

function WorkspaceBar(): React.JSX.Element {
  const workspace = useStore(appStore, (state) => state.projectWorkspace)
  // Single mode holds one thread per view and hides the strip, so the controls
  // for arranging views and applying layouts have nothing to act on.
  const single = useStore(appStore, (state) => state.viewMode) === 'single'
  const layouts = useStore(appStore, (state) => state.layouts)
  const undo = useStore(appStore, (state) => state.workspaceUndo)
  const [layoutsOpen, setLayoutsOpen] = useState(false)
  const [addHot, setAddHot] = useState(false)
  const [editingViewId, setEditingViewId] = useState<string | null>(null)
  const [viewNameDraft, setViewNameDraft] = useState('')
  const menuRef = useRef<HTMLDivElement>(null)
  const viewNameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!layoutsOpen) return
    const close = (event: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setLayoutsOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [layoutsOpen])

  useEffect(() => {
    setNativeViewsSuspended('workspace-layouts', layoutsOpen)
    return () => setNativeViewsSuspended('workspace-layouts', false)
  }, [layoutsOpen])

  useEffect(() => {
    if (!editingViewId) return
    viewNameRef.current?.focus()
    viewNameRef.current?.select()
  }, [editingViewId])

  // No confirm: applying a layout only moves tabs, and the workspace bar
  // offers Undo afterwards. It used to rebuild the view from scratch, which is
  // what needed asking about.
  const apply = (id: string): void => {
    setLayoutsOpen(false)
    applyLayout(id)
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
      <div className="workspace-view-tabs" role="tablist" aria-label="Project views" hidden={single}>
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
        {/* Dropping a tab here makes the view and puts the tab in it. Making
            the view first left an empty room to drag into, which is the step
            that stopped people splitting a crowded pane up. */}
        <button
          className={`workspace-view-add ${addHot ? 'drop' : ''}`}
          title="New view, or drop a tab here to start one"
          onClick={createWorkspaceView}
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes(TAB_DRAG_TYPE)) return
            event.preventDefault()
            setAddHot(true)
          }}
          onDragLeave={() => setAddHot(false)}
          onDrop={(event) => {
            event.preventDefault()
            setAddHot(false)
            const tabId = event.dataTransfer.getData(TAB_DRAG_TYPE)
            if (tabId) moveWorkspaceTabToNewView(tabId)
          }}
        >
          <PlusIcon size={13} />
        </button>
      </div>
      {single ? <SingleThreadTitle /> : null}
      <div className="workspace-bar-spacer" />
      {single ? <SinglePanelButton /> : null}
      {undo ? (
        <button className="workspace-undo" onClick={undoWorkspaceChange} title="Undo the last close">
          {undo.label} — Undo
        </button>
      ) : null}
      <div className="workspace-layout-control" ref={menuRef} hidden={single}>
        <button className="workspace-bar-button" onClick={() => setLayoutsOpen((open) => !open)}>
          <span>Layouts</span>
          {/* Drawn, not the ⌄ glyph it replaces: that character sits on the
              text baseline, so it hung below the middle of the button. */}
          <ChevronIcon size={12} className={`workspace-bar-caret ${layoutsOpen ? 'open' : ''}`} />
        </button>
        {layoutsOpen ? (
          <div className="workspace-layout-menu">
            {layouts.map((layout) => (
              <button key={layout.id} className="workspace-layout-row" onClick={() => apply(layout.id)}>
                {layout.name}
              </button>
            ))}
          </div>
        ) : null}
      </div>
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
  const single = useStore(appStore, (state) => state.viewMode) === 'single'

  // Detach native views for the whole of a drag. A browser is composited over
  // the page, so dragging across one never reaches the pane underneath: no
  // dragover to move the drop indicator, no dragleave to clear it, and no drop
  // at all. The indicator stuck wherever the cursor last crossed real DOM.
  useEffect(() => {
    const start = (): void => {
      // Lets a drop fall through the portal slot to the pane that handles it.
      document.body.classList.add('workspace-dragging')
    }
    const stop = (): void => {
      document.body.classList.remove('workspace-dragging')
    }
    document.addEventListener('dragstart', start)
    document.addEventListener('dragend', stop)
    document.addEventListener('drop', stop)
    // A drag cancelled with Escape, or released outside the window, fires
    // neither dragend nor drop. Without these the class stuck, every slot kept
    // pointer-events: none, and the whole workspace stopped taking input.
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') stop() }
    window.addEventListener('mouseup', stop)
    window.addEventListener('blur', stop)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('dragstart', start)
      document.removeEventListener('dragend', stop)
      document.removeEventListener('drop', stop)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('mouseup', stop)
      window.removeEventListener('blur', stop)
      stop()
    }
  }, [])

  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey)) return
      const target = event.target as HTMLElement | null
      // Typing a shortcut into a text field should insert nothing and do
      // nothing. The terminal is the exception: xterm takes input through a
      // hidden textarea, so without this it would look like a text field and
      // swallow every workspace shortcut whenever a terminal had focus.
      const inTerminal = Boolean(target?.closest('.terminal-view, .xterm'))
      if (!inTerminal && target?.matches('input, textarea, [contenteditable="true"]')) return
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
      } else if (event.code === 'BracketLeft' || event.code === 'BracketRight') {
        // Cmd+Shift+[ and ] step through the tabs of the focused pane, as they
        // do in VS Code. Wrapping at the ends matches every tabbed app.
        //
        // Matched on code rather than key: holding Shift turns [ into {, so
        // comparing event.key never matched and the shortcut did nothing.
        if (!event.shiftKey) return
        event.preventDefault()
        const index = focused.tabs.findIndex((item) => item.id === focused.activeTabId)
        if (index < 0 || focused.tabs.length < 2) return
        const step = event.code === 'BracketRight' ? 1 : -1
        const next = (index + step + focused.tabs.length) % focused.tabs.length
        activateWorkspaceTab(focused.id, focused.tabs[next].id)
      } else if (/^Digit[1-9]$/.test(event.code)) {
        // Cmd+9 means the last tab rather than the ninth, again as in VS Code.
        event.preventDefault()
        const position = Number(event.code.slice(-1))
        const target = position === 9 ? focused.tabs[focused.tabs.length - 1] : focused.tabs[position - 1]
        if (target) activateWorkspaceTab(focused.id, target.id)
      } else if (event.code.startsWith('Arrow')) {
        // Option+Cmd+Arrow moves between split panes. Plain Cmd+Arrow is left
        // alone so it keeps meaning line and document navigation inside text.
        //
        // Matched on code, as elsewhere here: Option is a compose key on macOS
        // and the reported key is not dependable while it is held.
        if (!event.altKey) return
        event.preventDefault()
        const direction = event.code.replace('Arrow', '').toLowerCase() as 'left' | 'right' | 'up' | 'down'
        focusNeighbor(direction)
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])

  if (!workspace) return <div className="workspace-loading">Open a project to load its views.</div>
  return (
    <TabSlotProvider>
      <div className="workspace-shell">
        <WorkspaceBar />
        {/* Every view stays mounted, inactive ones hidden. Rendering only the
            active tree unmounted the others, so switching views killed their
            terminals and restarted them on the way back. A view is a place
            your work sits, not a page that reloads. */}
        {workspace.views.map((view) => (
          <div
            key={view.id}
            className={`workspace-canvas ${single ? 'single' : ''}`}
            hidden={view.id !== workspace.activeViewId}
          >
            {/* Single mode hides the other panes rather than unmounting them,
                for the same reason inactive views stay mounted: a terminal that
                leaves the tree dies with it. Switching back to tiling has to
                find the layout exactly as it was left. */}
            <WorkspaceNodeView
              node={view.root}
              viewId={view.id}
              single={single}
              conversationId={single ? conversationGroupId(view) : undefined}
            />
          </div>
        ))}
        <TabContents workspace={workspace} />
      </div>
    </TabSlotProvider>
  )
}

/** Every tab's content, mounted once and portalled into whichever pane holds
 *  it. Living here rather than inside a pane is what lets a terminal survive
 *  being dragged elsewhere: its position in the React tree never changes,
 *  however far the tab moves. */
function TabContents({ workspace }: { workspace: WorkspaceState }): React.JSX.Element {
  return (
    <>
      {workspace.views.flatMap((view) =>
        walkGroups(view.root).flatMap((group) =>
          group.tabs.map((item) => (
            <TabContent
              key={item.id}
              groupId={group.id}
              item={item}
              active={item.id === group.activeTabId}
              viewShowing={workspace.activeViewId === view.id}
            />
          ))
        )
      )}
    </>
  )
}

function findGroupForKeyboard(node: WorkspaceNode, id: string): WorkspaceGroup | undefined {
  if (node.type === 'group') return node.id === id ? node : undefined
  return findGroupForKeyboard(node.first, id) ?? findGroupForKeyboard(node.second, id)
}
