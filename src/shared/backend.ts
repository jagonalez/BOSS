export const BACKEND_IDS = ['opencode', 'pi', 'codex', 'claude', 'lab'] as const
export type BackendId = typeof BACKEND_IDS[number]

export function isBackendId(value: string): value is BackendId {
  return (BACKEND_IDS as readonly string[]).includes(value)
}
export type BackendModeId = 'ask' | 'auto' | 'plan' | 'accept-edits'
export type ThreadCreationScope = 'current' | 'global'
export type DelegatePlacement = 'same-checkout' | 'new-worktree'

export interface BackendModeDescriptor {
  id: BackendModeId
  label: string
  description: string
}

export interface BackendCapabilities {
  streaming: boolean
  models: boolean
  permissions: boolean
  nativeFork: boolean
  steering: 'native' | 'stop-and-redirect'
  branching: 'message' | 'thread' | 'context-copy'
  images: boolean
  mcp: boolean
  interactiveQuestions: boolean
  /** The backend enforces its own Auto policy; escalations must still be shown to the user. */
  nativeAutoMode: boolean
  /** The backend can revert a thread to a message and restore what was reverted.
   *  Without it the transcript offers no undo, because pretending would drop
   *  nothing but report it dropped. */
  revert: boolean
  /** The backend can replace earlier context with a summary. */
  compact: boolean
}

export interface QueuedFollowUpAttachment {
  id: string
  name: string
  mime: string
  dataUrl: string
}

export interface QueuedFollowUp {
  id: string
  threadId: string
  text: string
  attachments: QueuedFollowUpAttachment[]
  options?: BackendMessageOptions
  createdAt: number
  /** When the user steered this one to the front. Set only on a steered
   *  follow-up, and what keeps two steers in the order they were made rather
   *  than letting the second overtake the first. */
  steeredAt?: number
}

export interface BackendDescriptor {
  id: BackendId
  label: string
  description: string
  available: boolean
  healthy: boolean
  version?: string
  command?: string
  unavailableReason?: string
  /** Set when the backend runs but its version is older than the one BOSS was
   *  checked against. Advisory: the backend is still available. */
  versionWarning?: string
  capabilities: BackendCapabilities
  modes: BackendModeDescriptor[]
}

export interface BackendAuthStatus {
  backendId: BackendId
  state: 'connected' | 'not-connected' | 'unknown'
  detail: string
  accounts?: string[]
}

/** A quota window reported by a provider account, not activity inferred by
 * BOSS. `resetLabel` keeps provider-supplied timezone wording intact when a
 * CLI does not provide an epoch timestamp. */
export interface SubscriptionUsageWindow {
  /** Provider-defined bucket, such as the shared Codex pool or Spark. */
  group?: string
  label: string
  usedPercent: number
  resetsAt?: number
  resetLabel?: string
}

export interface BackendSubscriptionUsage {
  backendId: BackendId
  plan?: string
  windows: SubscriptionUsageWindow[]
  /** Why a connected provider cannot currently expose a provider quota. */
  unavailableReason?: string
  updatedAt: number
}

export interface BackendModelDescriptor {
  id: string
  name?: string
  provider?: string
  /** Human-readable provider label when the provider id is an opaque stable id. */
  providerName?: string
  variants?: string[]
  source?: 'local' | 'cloud' | 'custom'
}

export interface BackendModelPreference {
  modelID: string
  providerID: string
  /** Thinking level, when the chosen model offers one. Stored beside the model
   *  rather than per backend because the levels belong to the model: claude's
   *  Sonnet stops at high where Opus goes to max, and codex reads them from
   *  each model's own list. A level saved against one model means nothing to
   *  another. */
  variant?: string
  /** How much the agent may do without asking. Per backend, because the modes
   *  are the backend's own — codex has no accept-edits, pi has one mode. */
  mode?: BackendModeId
}

export interface LabConnectionModel {
  id: string
  name?: string
  source?: 'local' | 'cloud' | 'custom'
}

/** One OpenAI-compatible API available to Lab. Keys deliberately never leave
 * main; the renderer only learns whether a key is configured. */
export interface LabConnection {
  id: string
  name: string
  baseUrl: string
  apiKeyConfigured: boolean
  healthy: boolean
  manualModels: string[]
  models: LabConnectionModel[]
}

export interface LabConnectionsSettings {
  connections: LabConnection[]
}

export interface LabConnectionUpdate {
  /** Omit when adding a connection. */
  id?: string
  name: string
  baseUrl: string
  manualModels: string[]
  /** Omit to keep the existing key. */
  apiKey?: string
  /** Remove the securely stored key. */
  clearApiKey?: boolean
}

export type { ThreadTitleSettings } from './thread-title'
export type { SandboxSettings } from './sandbox'

export interface BackendMessageOptions {
  model?: { providerID: string; modelID: string; variant?: string }
  agent?: string
  mode?: BackendModeId
  /** Headless runs: restrict the agent to BOSS-provided tools, ignoring user-level MCP configs. */
  strictTools?: boolean
  /** Which project and checkout this thread is working in, ready to put in the
   *  system prompt. Without it an agent infers its project from the directory
   *  it happens to be in, and infers the repository from whatever else it can
   *  see — one asked about a browser tab and guessed. */
  context?: string
}

/** Fill a newly-created thread's first turn from the owning backend's saved
 * defaults. Explicit per-thread choices always win. Kept in the shared layer
 * because renderer-created and agent-created threads must resolve the same
 * settings even though the latter never pass through renderer state. */
export function withBackendDefaults(
  preference: BackendModelPreference | undefined,
  options?: BackendMessageOptions,
  fallbackMode?: BackendModeId
): BackendMessageOptions {
  const model = options?.model ?? (preference ? {
    providerID: preference.providerID,
    modelID: preference.modelID,
    ...(preference.variant ? { variant: preference.variant } : {})
  } : undefined)
  const mode = options?.mode ?? preference?.mode ?? fallbackMode
  return {
    ...options,
    ...(model ? { model } : {}),
    ...(mode ? { mode } : {})
  }
}

/** What main throws when a thread is asked to run while it is already running.
 *
 * Main is the only place that knows this without a race: the renderer decides
 * between sending and queueing from a snapshot of the busy state, and two sends
 * in quick succession both read "idle". Sent as a recognisable message rather
 * than an error subclass because IPC delivers only the message across. */
export const THREAD_BUSY_ERROR = 'boss:thread-busy'

/** Whether an error only says a run was stopped.
 *
 * A backend reports the stop BOSS asked for as an error on the run, naming it
 * rather than describing a fault: opencode sends MessageAbortedError, and
 * others say the request was aborted or cancelled. Shown to the user, that
 * reads as a failure of something they asked for. Matched on the name as well
 * as the message, so a genuine fault that merely happens during a stop still
 * gets through. */
export function isAbortError(value: unknown): boolean {
  const record = value && typeof value === 'object'
    ? value as { name?: unknown; message?: unknown; data?: { message?: unknown } }
    : undefined
  const text = [
    typeof value === 'string' ? value : undefined,
    typeof record?.name === 'string' ? record.name : undefined,
    typeof record?.message === 'string' ? record.message : undefined,
    typeof record?.data?.message === 'string' ? record.data.message : undefined
  ].filter(Boolean).join(' ')
  return text ? /\b(abort|aborted|cancelled|canceled)\b/i.test(text) : false
}

export type BackendRequest =
  | { type: 'backend.list' }
  | { type: 'backend.auth.status' }
  | { type: 'backend.subscription-usage' }
  | { type: 'backend.defaults.set'; defaults: Partial<Record<BackendId, BackendModelPreference>> }
  | { type: 'lab.connections.get' }
  | { type: 'lab.connection.save'; connection: LabConnectionUpdate }
  | { type: 'lab.connection.delete'; connectionId: string }
  | { type: 'thread.title.settings.get' }
  | { type: 'thread.title.settings.set'; autoNameFromFirstPrompt: boolean }
  | { type: 'sandbox.settings.get' }
  | { type: 'sandbox.settings.set'; networkAccess: boolean }
  | { type: 'backend.bin.get' }
  /** An empty or omitted path clears the override, returning the backend to PATH. */
  | { type: 'backend.bin.set'; backendId: BackendId; path?: string }
  /** Stop this backend's server so the next request starts a fresh one. Reads
   *  credentials again, which a running server never does. */
  | { type: 'backend.restart'; backendId: BackendId }
  | { type: 'thread.list' }
  | { type: 'thread.create'; backendId: BackendId; title?: string; scope?: ThreadCreationScope; executionPath?: string }
  | { type: 'thread.backend.set'; threadId: string; backendId: BackendId }
  | { type: 'thread.get'; threadId: string }
  | { type: 'thread.delete'; threadId: string }
  | { type: 'thread.rename'; threadId: string; title: string }
  /** `trimOutput` caps how many characters of a tool part's output come back,
   *  and sets `outputTruncated` to the full length on anything it shortened.
   *  A phone asks for this: tool output is most of a transcript's bytes and
   *  none of what a phone draws, which is a step summary. thread.part fetches
   *  one in full when a step is opened. */
  | { type: 'thread.messages'; threadId: string; limit?: number; trimOutput?: number }
  /** One tool part's untrimmed output, for a step the user opened. */
  | { type: 'thread.part'; threadId: string; messageId: string; partId: string }
  | { type: 'thread.send'; threadId: string; parts: unknown[]; options?: BackendMessageOptions }
  | { type: 'thread.followups.list'; threadId: string }
  | { type: 'thread.followups.add'; threadId: string; text: string; attachments?: QueuedFollowUpAttachment[]; options?: BackendMessageOptions }
  | { type: 'thread.followups.update'; threadId: string; followUpId: string; text: string }
  | { type: 'thread.followups.remove'; threadId: string; followUpId: string }
  | { type: 'thread.followups.move'; threadId: string; followUpId: string; toIndex: number }
  | { type: 'thread.followups.steer'; threadId: string; followUpId: string }
  | { type: 'thread.abort'; threadId: string }
  | { type: 'thread.mode.set'; threadId: string; mode: BackendModeId }
  | { type: 'thread.todos'; threadId: string }
  | { type: 'thread.permission'; threadId: string; permissionId: string; response: 'once' | 'always' | 'reject' }
  /** `path` narrows to one file, and `summary` asks for paths and counts with
   *  no file contents at all.
   *
   *  Both exist for the relay: diffGet returns every changed file in full, and
   *  a handful of edited files exceeds the frame cap on its own. A diff also
   *  cannot be trimmed the way a transcript can — dropping files from a list of
   *  changes silently hides them. So a remote client lists with `summary` and
   *  fetches one `path` at a time. The desktop passes neither and is unchanged. */
  | { type: 'thread.diff'; threadId: string; messageId?: string; path?: string; summary?: boolean }
  | { type: 'thread.fork'; threadId: string; messageId?: string }
  | { type: 'thread.revert'; threadId: string; messageId: string }
  | { type: 'thread.unrevert'; threadId: string }
  | { type: 'thread.command'; threadId: string; command: string; arguments: string; options?: BackendMessageOptions }
  | { type: 'thread.question'; threadId: string; requestId: string; answers: string[][] }
  | { type: 'thread.compact'; threadId: string; model?: { providerID: string; modelID: string } }
  | { type: 'thread.models'; threadId?: string; backendId?: BackendId }
  | { type: 'supervision.snapshot' }
  | { type: 'supervision.search'; query: string; limit?: number; threadId?: string }
  | { type: 'supervision.acknowledge'; threadId: string }
  /** Hide a thread from the default list, or bring it back. Recorded on the
   *  thread so every client agrees, rather than in one window's storage. */
  | { type: 'thread.archive'; threadId: string; archived: boolean }
  /** Keep a thread at the top of its section, or stop keeping it there.
   *  Recorded on the thread like archiving is, for the same reason. */
  | { type: 'thread.pin'; threadId: string; pinned: boolean }
  /** What this thread has spent, as the backend reported it, and what its
   *  budget still allows. Numbers a backend never reported stay absent. */
  | { type: 'thread.usage'; threadId: string }
  | { type: 'thread.policy.get'; threadId: string }
  | { type: 'thread.policy.set'; threadId: string; policy: import('./task-policy').TaskPolicy }
  | { type: 'thread.clone'; threadId: string; backendId: BackendId; instruction?: string; options?: BackendMessageOptions }
  | { type: 'thread.delegate'; threadId: string; backendId: BackendId; instruction: string; placement: DelegatePlacement; options?: BackendMessageOptions }
  | { type: 'thread.fanOut'; threadId: string; task: string; workers: import('./fan-out').FanOutWorker[]; options?: BackendMessageOptions }
  | { type: 'thread.worktree.create'; threadId: string; messageId?: string; instruction?: string; options?: BackendMessageOptions }
  | { type: 'worktree.list'; threadId?: string }
  | { type: 'worktree.settings.get' }
  | { type: 'worktree.settings.set'; autoCleanupEnabled?: boolean; cleanupAfterDays?: number; location?: import('./worktree').WorktreeLocation }
  | { type: 'worktree.remove'; worktreeId: string }
  | { type: 'thread.relay'; sourceThreadId: string; targetThreadId: string; instruction?: string }
  | { type: 'automation.list' }
  | { type: 'automation.create'; input: import('./automation').AutomationInput }
  | { type: 'automation.update'; automationId: string; patch: Partial<import('./automation').AutomationInput> & { enabled?: boolean } }
  | { type: 'automation.delete'; automationId: string }
  | { type: 'automation.run'; automationId: string }
  | { type: 'automation.stop'; automationId: string }
  | { type: 'automation.webhook.get' }
  | { type: 'automation.webhook.set'; url?: string; onlyWhenAway?: boolean }
  /** The per-automation hook secret and full URL. Never included in snapshots,
   *  so phones and the relay cannot read it. */
  | { type: 'automation.webhook.token'; automationId: string }
  | { type: 'assistant.snapshot' }
  | { type: 'assistant.answer'; questionId: string; answerId: string }
  | { type: 'assistant.task.create'; input: import('./lab-assistant').LabAssistantTaskInput }
  | { type: 'assistant.task.update'; taskId: string; patch: import('./lab-assistant').LabAssistantTaskPatch }
  | { type: 'assistant.task.assign'; taskId: string; threadId: string }
  | { type: 'mcp.list' }
  | { type: 'mcp.add'; input: import('./mcp').McpConnectionInput }
  | { type: 'mcp.update'; connectionId: string; patch: Partial<import('./mcp').McpConnectionInput> & { enabled?: boolean } }
  | { type: 'mcp.remove'; connectionId: string }
  | { type: 'mcp.import.scan' }
  | { type: 'mobile.status' }
  | { type: 'mobile.set'; patch: { enabled?: boolean; port?: number; tailscale?: boolean; regenerateToken?: boolean; regenerateViewerToken?: boolean } }
  | { type: 'telegram.status' }
  | { type: 'telegram.set'; patch: { enabled?: boolean; threadId?: string; allowedChats?: number[]; token?: string; clearToken?: boolean } }
  | { type: 'remote.status' }
  | { type: 'remote.set'; patch: { enabled?: boolean; relayUrl?: string; forgetDeviceId?: string; revokeAll?: boolean } }
  | { type: 'remote.pair' }
  | { type: 'remote.pair.cancel' }
  | { type: 'thread.bus.get'; threadId?: string }
  | { type: 'thread.bus.policy'; policy: import('./thread-bus').CollaborationPolicy | null; threadId?: string; projectId?: string }
  | { type: 'thread.bus.default-policy'; policy: import('./thread-bus').CollaborationPolicy; threadId?: string }
  | { type: 'thread.bus.clear-failures'; threadId?: string }
  | { type: 'thread.qa.get'; threadId: string }
  | { type: 'thread.qa.policy'; threadId: string; policy: import('./qa').QaPolicy | null }
  | { type: 'qa.default.get' }
  | { type: 'qa.default.policy'; policy: import('./qa').QaPolicy }
