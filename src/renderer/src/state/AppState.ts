import type {
  Agent,
  ConfigInfo,
  FileDiff,
  FileNode,
  MessageInfo,
  MessageWithParts,
  Part,
  PermissionRequest,
  Project,
  Provider,
  SessionInfo,
  SessionMeta,
  PanelGroup,
  PanelKind,
  PanelTab,
  Todo
} from '@shared/opencode'
import type {
  BrowseNavigationState,
  ComputerUseStatus,
  OptionalComponentId,
  OptionalComponentInfo,
  OptionalDownloadEvent
} from '@shared/ipc'
import { Store } from '../lib/store'
import { errorSummary } from '../lib/errors'

export { useStore } from '../lib/store'

export type { PanelKind, PanelTab, PanelGroup }

export const MAIN_MIN_WIDTH = 420
export const SIDEBAR_FALLBACK_WIDTH = 280

export interface Attachment {
  id: string
  name: string
  mime: string
  dataUrl: string
}

export interface AppState {
  serverUrl: string
  serverVersion: string
  serverHealthy: boolean
  sessions: SessionInfo[]
  activeSessionId: string | null
  messages: Record<string, MessageWithParts[]>
  projects: Project[]
  agents: Agent[]
  providers: Provider[]
  config: ConfigInfo | null
  diffs: FileDiff[] | null
  files: FileNode[] | null
  fileContent: { path: string; content: string } | null
  todos: Record<string, Todo[]>
  permission: PermissionRequest | null
  modelSwitch: { to: string } | null
  commitPath: string | null
  renameTarget: string | null
  confirm: { title: string; message: string; confirmLabel: string; destructive?: boolean; action: () => void } | null
  panelOpen: boolean
  panelGroups: PanelGroup[]
  reviewFile: string | null
  browse: Record<string, BrowseNavigationState>
  optional: OptionalComponentInfo[]
  optionalProgress: Partial<Record<OptionalComponentId, OptionalDownloadEvent>>
  computerUse: ComputerUseStatus
  streaming: boolean
  streamingLocked: boolean
  sessionBusy: Record<string, boolean>
  compacting: Record<string, boolean>
  model: string | null
  variant: string | null
  mode: 'auto' | 'ask' | 'plan'
  agent: string
  projectPath: string
  lastError: string | null
  drafts: Record<string, string>
  attachments: Record<string, Attachment[]>
  history: Record<string, string[]>
  archived: string[]
  reverted: Record<string, string[]>
  gitRefresh: number
  composerEpoch: number
  settingsOpen: boolean
  sessionMeta: Record<string, SessionMeta>
  chatOrder: string[]
  launcherProject: string | null
  attention: { kind: 'permission' | 'done' | 'error'; ts: number } | null
}

export const initialBrowseState: BrowseNavigationState = {
  url: '',
  title: '',
  canGoBack: false,
  canGoForward: false,
  loading: false
}

export const initialState: AppState = {
  serverUrl: '',
  serverVersion: '',
  serverHealthy: false,
  sessions: [],
  activeSessionId: null,
  messages: {},
  projects: [],
  agents: [],
  providers: [],
  config: null,
  diffs: null,
  files: null,
  fileContent: null,
  todos: {},
  permission: null,
  modelSwitch: null,
  commitPath: null,
  renameTarget: null,
  confirm: null,
  panelOpen: false,
  panelGroups: [],
  reviewFile: null,
  browse: {},
  optional: [],
  optionalProgress: {},
  computerUse: { enabled: false, running: false },
  streaming: false,
  streamingLocked: false,
  sessionBusy: {},
  compacting: {},
  model: null,
  variant: null,
  mode: 'ask',
  agent: 'build',
  projectPath: '',
  lastError: null,
  drafts: {},
  attachments: {},
  history: {},
  archived: [],
  reverted: {},
  gitRefresh: 0,
  composerEpoch: 0,
  settingsOpen: false,
  sessionMeta: {},
  chatOrder: [],
  launcherProject: null,
  attention: null
}

export const appStore = new Store<AppState>(initialState)

function upsertMessage(messages: Record<string, MessageWithParts[]>, message: MessageInfo): Record<string, MessageWithParts[]> {
  const list = [...(messages[message.sessionID] ?? [])]
  const idx = list.findIndex((m) => m.info.id === message.id)
  if (idx >= 0) {
    list[idx] = { ...list[idx], info: message }
  } else {
    list.push({ info: message, parts: [] })
  }
  return { ...messages, [message.sessionID]: list }
}

function upsertPart(messages: Record<string, MessageWithParts[]>, part: Part): Record<string, MessageWithParts[]> {
  const list = [...(messages[part.sessionID] ?? [])]
  const midx = list.findIndex((m) => m.info.id === part.messageID)
  if (midx < 0) {
    const info: MessageInfo = {
      id: part.messageID,
      sessionID: part.sessionID,
      role: 'assistant'
    }
    return { ...messages, [part.sessionID]: [...list, { info, parts: [part] }] }
  }
  const msg = list[midx]
  const parts = [...msg.parts]
  const pidx = parts.findIndex((p) => p.id === part.id)
  if (pidx >= 0) {
    parts[pidx] = part
  } else {
    parts.push(part)
  }
  const next = [...list]
  next[midx] = { ...msg, parts }
  return { ...messages, [part.sessionID]: next }
}

export function upsertMessagesFromList(messages: Record<string, MessageWithParts[]>, incoming: MessageWithParts[]): Record<string, MessageWithParts[]> {
  let next = messages
  for (const item of incoming) {
    const sessionID = item.info.sessionID
    const list = [...(next[sessionID] ?? [])]
    const idx = list.findIndex((m) => m.info.id === item.info.id)
    if (idx >= 0) {
      list[idx] = item
    } else {
      list.push(item)
    }
    next = { ...next, [sessionID]: list }
  }
  return next
}

export function applyEvent(state: AppState, ev: Record<string, unknown>): Partial<AppState> {
  const props = (ev.properties ?? {}) as Record<string, unknown>
  switch (ev.type) {
    case 'server.connected':
      return { serverHealthy: true }
    case 'server.disconnected':
      return { serverHealthy: false }
    case 'session.updated':
    case 'session.created':
    case 'session.deleted':
      return {}
    case 'message.updated': {
      const info = (props.info ?? props.message) as MessageInfo | undefined
      return info ? { messages: upsertMessage(state.messages, info) } : {}
    }
    case 'message.part.updated':
    case 'message.part.created': {
      const part = props.part as Part | undefined
      if (!part) return {}
      const patch: Partial<AppState> = { messages: upsertPart(state.messages, part) }
      if (part.type === 'compaction') {
        patch.compacting = { ...state.compacting, [part.sessionID]: true }
      }
      return patch
    }
    case 'todo.updated': {
      const sid = props.sessionID as string | undefined
      const todos = props.todos as Todo[] | undefined
      return sid && todos ? { todos: { ...state.todos, [sid]: todos } } : {}
    }
    case 'permission.asked':
    case 'permission.updated':
      return { permission: (props as unknown as PermissionRequest) ?? null }
    case 'permission.replied':
      return { permission: null }
    case 'session.status': {
      const sid = props.sessionID as string | undefined
      const status = (props.status as { type?: string } | undefined)?.type
      if (!sid) return {}
      const busy = status === 'busy' || status === 'retry'
      return { sessionBusy: { ...state.sessionBusy, [sid]: busy } }
    }
    case 'session.idle': {
      const sid = props.sessionID as string | undefined
      if (!sid) return {}
      return { sessionBusy: { ...state.sessionBusy, [sid]: false } }
    }
    case 'session.compacted': {
      const sid = props.sessionID as string | undefined
      if (!sid) return {}
      return { compacting: { ...state.compacting, [sid]: false } }
    }
    case 'session.error':
      return { lastError: errorSummary(props.error ?? props.message ?? 'opencode error') }
    case 'config.updated':
      return {}
    default:
      return {}
  }
}
