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
  QuestionRequest,
  SessionInfo,
  SessionMeta,
  Todo
} from '@shared/opencode'
import type { BackendAuthStatus, BackendDescriptor, BackendId, BackendModeId, BackendModelDescriptor, BackendModelPreference, BackendSubscriptionUsage, QueuedFollowUp } from '@shared/backend'
import type { Annotation } from '@shared/annotations'
import type { ThreadBusSnapshot } from '@shared/thread-bus'
import type { QaPolicy, QaPolicyState } from '@shared/qa'
import type { AutomationsSnapshot } from '@shared/automation'
import type { McpConnectionView } from '@shared/mcp'
import type {
  BrowseNavigationState,
  CloudflareSettings,
  ComputerUsePermissions,
  ComputerUseStatus,
  OptionalComponentId,
  OptionalComponentInfo,
  OptionalDownloadEvent,
  SiteInfo
} from '@shared/ipc'
import type { ProjectInfo } from '@shared/ipc'
import type { AsrStatus, TtsStatus } from '@shared/speech'
import type { AppPage, Layout, ViewMode, Workspace, TerminalStartLocation } from '@shared/workspace'
import { Store } from '../lib/store'
import { errorSummary } from '../lib/errors'
import type { ActivityFeedState } from '../lib/activity-feed'
import type { UiDensity, UiFontSize } from '../lib/themes'

export { useStore } from '../lib/store'

export interface Attachment {
  id: string
  name: string
  mime: string
  dataUrl: string
}

/** A send that did not reach the backend, kept so the user can retry it.
 *
 *  Session-scoped rather than global because lastErrorBySession cannot say
 *  which message failed, and the text has to survive with its attachments or
 *  a retry silently drops the images the user pasted. */
export interface FailedSend {
  text: string
  attachments: Attachment[]
  error: string
}

export interface AppState {
  activePage: AppPage
  projectWorkspace: Workspace | null
  /** Tiling, or one thread at a time. See ViewMode in @shared/workspace. */
  viewMode: ViewMode
  /** Tab to flash after it lands somewhere new. Clears itself. */
  highlightedTabId?: string
  /** Browser tabs an agent has driven since you last looked at them. Keyed by
   *  browse id, so `workspace-${tabId}`. */
  browseAgentActivity: Record<string, boolean>
  /** Offer to undo the last close. Expires on its own. */
  workspaceUndo: { label: string } | null
  layouts: Layout[]
  nativeViewSuspensions: string[]
  serverUrl: string
  serverVersion: string
  serverHealthy: boolean
  sessions: SessionInfo[]
  activeSessionId: string | null
  messages: Record<string, MessageWithParts[]>
  projects: Project[]
  agents: Agent[]
  providers: Provider[]
  providersBySession: Record<string, Provider[]>
  config: ConfigInfo | null
  diffs: FileDiff[] | null
  files: FileNode[] | null
  fileContent: { path: string; content: string } | null
  todos: Record<string, Todo[]>
  permissions: Record<string, PermissionRequest>
  questions: Record<string, QuestionRequest>
  modelSwitch: { to: string; providerID?: string; sessionId?: string } | null
  commitPath: string | null
  renameTarget: string | null
  delegateTarget: string | null
  policyTarget: string | null
  /** `notice` drops the Cancel button: there is nothing to decline. */
  confirm: { title: string; message: string; confirmLabel: string; destructive?: boolean; notice?: boolean; action: () => void } | null
  reviewFile: string | null
  browse: Record<string, BrowseNavigationState>
  optional: OptionalComponentInfo[]
  optionalProgress: Partial<Record<OptionalComponentId, OptionalDownloadEvent>>
  computerUse: ComputerUseStatus
  computerUsePerms: ComputerUsePermissions
  streaming: Record<string, boolean>
  streamingLocked: Record<string, boolean>
  sessionBusy: Record<string, boolean>
  compacting: Record<string, boolean>
  model: string | null
  modelProvider: string | null
  variant: string | null
  mode: BackendModeId
  modelsBySession: Record<string, string>
  modelProvidersBySession: Record<string, string>
  variantsBySession: Record<string, string | null>
  modesBySession: Record<string, BackendModeId>
  /** Threads whose mode change cannot take effect until their next message,
   *  because the backend fixes its approval policy for the whole turn. */
  modePending: Record<string, BackendModeId>
  agent: string
  engine: BackendId
  backends: BackendDescriptor[]
  backendAuth: BackendAuthStatus[]
  subscriptionUsage: BackendSubscriptionUsage[]
  backendModels: Partial<Record<BackendId, BackendModelDescriptor[]>>
  backendModelsLoading: boolean
  defaultModels: Partial<Record<BackendId, BackendModelPreference>>
  authTerminalBackends: Record<string, BackendId>
  threadBus: ThreadBusSnapshot | null
  qaPolicies: Record<string, QaPolicyState>
  qaDefault: QaPolicy
  automations: AutomationsSnapshot | null
  mcpConnections: McpConnectionView[]
  projectPath: string
  selectedCheckoutPath: string
  projectCheckouts: ProjectInfo['checkouts']
  terminalStartLocation: TerminalStartLocation
  lastError: string | null
  lastErrorBySession: Record<string, string>
  failedSendBySession: Record<string, FailedSend | undefined>
  drafts: Record<string, string>
  attachments: Record<string, Attachment[]>
  /** Highlights pending on each thread's composer. Cleared on send: an
   *  annotation is a way to phrase one prompt, not a note kept on the thread. */
  annotations: Record<string, Annotation[]>
  followUps: Record<string, QueuedFollowUp[]>
  history: Record<string, string[]>
  archived: string[]
  reverted: Record<string, string[]>
  gitRefresh: number
  composerEpoch: number
  settingsOpen: boolean
  sessionMeta: Record<string, SessionMeta>
  chatOrder: string[]
  launcherProject: string | null
  attention: { kind: 'permission' | 'question' | 'done' | 'error'; ts: number } | null
  /** Persistent history of attention-worthy events, capped and read-marked.
   *  The ephemeral `attention` pill above is the nudge; this is the record. */
  activity: ActivityFeedState
  inboxOpen: boolean
  /** Command palette overlay (Cmd+K). */
  paletteOpen: boolean
  uiFontSize: UiFontSize
  uiDensity: UiDensity
  tts: TtsStatus
  asr: AsrStatus
  asrTargetId: string | null
  ttsVoice: string
  speakAloud: boolean
  /** The turn being read aloud in this window, keyed by its last message id.
   *  Renderer-side playback state: main's TTS status cannot see the audio
   *  elements speakText() plays here, so the stop control reads this. */
  speakingKey: string | null
  sites: SiteInfo[]
  cloudflare: CloudflareSettings
  siteDeploying: Record<string, boolean>
  siteUnpublishing: Record<string, boolean>
}

export const initialBrowseState: BrowseNavigationState = {
  url: '',
  title: '',
  canGoBack: false,
  canGoForward: false,
  loading: false
}

export const initialState: AppState = {
  activePage: 'command-center',
  projectWorkspace: null,
  viewMode: 'multi',
  browseAgentActivity: {},
  workspaceUndo: null,
  layouts: [],
  nativeViewSuspensions: [],
  serverUrl: '',
  serverVersion: '',
  serverHealthy: false,
  sessions: [],
  activeSessionId: null,
  messages: {},
  projects: [],
  agents: [],
  providers: [],
  providersBySession: {},
  config: null,
  diffs: null,
  files: null,
  fileContent: null,
  todos: {},
  permissions: {},
  questions: {},
  modelSwitch: null,
  commitPath: null,
  renameTarget: null,
  delegateTarget: null,
  policyTarget: null,
  confirm: null,
  reviewFile: null,
  browse: {},
  optional: [],
  optionalProgress: {},
  computerUse: { supported: false, enabled: false, running: false },
  computerUsePerms: { available: false, accessibility: false, screenRecording: false },
  streaming: {},
  streamingLocked: {},
  sessionBusy: {},
  compacting: {},
  model: null,
  modelProvider: null,
  variant: null,
  mode: 'ask',
  modelsBySession: {},
  modelProvidersBySession: {},
  variantsBySession: {},
  modesBySession: {},
  modePending: {},
  agent: 'build',
  engine: 'opencode',
  backends: [],
  backendAuth: [],
  subscriptionUsage: [],
  backendModels: {},
  backendModelsLoading: false,
  defaultModels: {},
  authTerminalBackends: {},
  threadBus: null,
  qaPolicies: {},
  qaDefault: 'suggest',
  automations: null,
  mcpConnections: [],
  projectPath: '',
  selectedCheckoutPath: '',
  projectCheckouts: [],
  terminalStartLocation: 'focused-checkout',
  lastError: null,
  lastErrorBySession: {},
  failedSendBySession: {},
  drafts: {},
  attachments: {},
  annotations: {},
  followUps: {},
  history: {},
  archived: [],
  reverted: {},
  gitRefresh: 0,
  composerEpoch: 0,
  settingsOpen: false,
  sessionMeta: {},
  chatOrder: [],
  launcherProject: null,
  attention: null,
  activity: { events: [], lastReadTs: 0 },
  inboxOpen: false,
  paletteOpen: false,
  uiFontSize: 'default',
  uiDensity: 'comfortable',
  tts: { available: false, ready: false, speaking: false },
  asr: { available: false, listening: false },
  asrTargetId: null,
  ttsVoice: 'af_heart',
  speakAloud: false,
  speakingKey: null,
  sites: [],
  cloudflare: { configured: false },
  siteDeploying: {},
  siteUnpublishing: {}
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
      if (part.type === 'compaction' && part.state?.status !== 'completed') {
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
    case 'permission.updated': {
      const perm = (props as unknown as PermissionRequest) ?? null
      if (!perm?.sessionID) return {}
      return { permissions: { ...state.permissions, [perm.sessionID]: perm } }
    }
    case 'permission.replied': {
      const sid = props.sessionID as string | undefined
      if (!sid) return {}
      const next = { ...state.permissions }
      delete next[sid]
      return { permissions: next }
    }
    case 'question.asked': {
      const question = (props as unknown as QuestionRequest) ?? null
      if (!question?.sessionID) return {}
      return { questions: { ...state.questions, [question.sessionID]: question } }
    }
    case 'question.replied':
    case 'question.rejected': {
      const sid = props.sessionID as string | undefined
      const requestID = props.requestID as string | undefined
      if (!sid || !requestID || state.questions[sid]?.id !== requestID) return {}
      const next = { ...state.questions }
      delete next[sid]
      return { questions: next }
    }
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
    case 'session.compaction.started': {
      const sid = props.sessionID as string | undefined
      if (!sid) return {}
      return { compacting: { ...state.compacting, [sid]: true } }
    }
    case 'session.compacted': {
      const sid = props.sessionID as string | undefined
      if (!sid) return {}
      return { compacting: { ...state.compacting, [sid]: false } }
    }
    case 'session.error': {
      const sid = props.sessionID as string | undefined
      // Every backend raises session.error, so the fallback must not name one.
      const msg = errorSummary(props.error ?? props.message ?? 'The agent reported an error')
      if (!sid) return { lastError: msg }
      return {
        lastErrorBySession: { ...(state as { lastErrorBySession?: Record<string, string> }).lastErrorBySession, [sid]: msg },
        compacting: { ...state.compacting, [sid]: false }
      }
    }
    case 'config.updated':
      return {}
    case 'thread.bus.updated': {
      const snapshot = props.snapshot as ThreadBusSnapshot | undefined
      return snapshot && (!state.projectPath || snapshot.projectPath === state.projectPath) ? { threadBus: snapshot } : {}
    }
    case 'thread.followups.updated': {
      const threadId = props.threadId as string | undefined
      const followUps = props.followUps as QueuedFollowUp[] | undefined
      return threadId && followUps ? { followUps: { ...state.followUps, [threadId]: followUps } } : {}
    }
    case 'automations.updated': {
      const snapshot = props.snapshot as AutomationsSnapshot | undefined
      return snapshot ? { automations: snapshot } : {}
    }
    case 'mcp.updated': {
      const connections = props.connections as McpConnectionView[] | undefined
      return connections ? { mcpConnections: connections } : {}
    }
    default:
      return {}
  }
}
