import type { HttpMethod } from '@shared/ipc'
import type {
  Agent,
  Command,
  ConfigInfo,
  FileContent,
  FileDiff,
  FileNode,
  MessageWithParts,
  Project,
  Provider,
  SessionInfo,
  Todo
} from '@shared/opencode'
import type { BackendAuthStatus, BackendDescriptor, BackendId, BackendMessageOptions, BackendModeId, BackendModelDescriptor, BackendModelPreference, BackendRequest, DelegatePlacement, QueuedFollowUp, QueuedFollowUpAttachment, SandboxSettings, ThreadCreationScope, ThreadTitleSettings } from '@shared/backend'
import type { FanOutWorker } from '@shared/fan-out'
import type { CollaborationPolicy, ThreadBusSnapshot } from '@shared/thread-bus'
import type { WorktreeInfo, WorktreeSettings } from '@shared/worktree'
import type { QaPolicy, QaPolicyState } from '@shared/qa'
import type { Automation, AutomationInput, AutomationsSnapshot } from '@shared/automation'
import type { WebhookSettings } from '@shared/notification'
import type { McpConnectionInput, McpConnectionView, McpImportCandidate } from '@shared/mcp'
import type { MobileAccessStatus } from '@shared/mobile'
import type { RemoteAccessStatus } from '@shared/relay'
import type { SupervisionSnapshot, TranscriptSearchResult } from '@shared/supervision'
import type { TaskPolicy } from '@shared/task-policy'

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    detail: unknown
  ) {
    super(`${path} -> ${status}: ${JSON.stringify(detail)}`)
  }
}

async function request<T>(method: HttpMethod, path: string, opts?: { query?: Record<string, string | number | boolean | undefined>; body?: unknown; directory?: string }): Promise<T> {
  const res = await window.boss.apiRequest({
    method,
    path,
    query: opts?.query,
    body: opts?.body,
    directory: opts?.directory
  })
  if (res.status === 0) {
    throw new ApiError(0, path, res.body)
  }
  if (res.status < 200 || res.status >= 300) {
    throw new ApiError(res.status, path, res.body)
  }
  return res.body as T
}

async function backendRequest<T>(req: BackendRequest): Promise<T> {
  return window.boss.backendRequest(req) as Promise<T>
}

export interface ModelOption {
  id: string
  name?: string
  free?: boolean
  providerID: string
  variants: string[]
}

export function isHighVariant(id: string): boolean {
  return /high.?speed|turbo|fast/i.test(id)
}

function isFreeCost(cost?: unknown): boolean {
  if (!cost || typeof cost !== 'object') return false
  const c = cost as { input?: number; output?: number; cache?: { read?: number; write?: number } }
  return c.input === 0 && c.output === 0 && c.cache?.read === 0 && c.cache?.write === 0
}

export function providerModels(p: Provider): ModelOption[] {
  const models = p.models
  if (!models) return []
  if (Array.isArray(models)) {
    return models
      .map((m) => {
        if (typeof m === 'string') return { id: m, name: m, providerID: p.id, variants: [] }
        const mm = m as { id?: unknown; name?: unknown; cost?: unknown; variants?: unknown }
        return {
          id: String(mm.id ?? ''),
          name: typeof mm.name === 'string' ? mm.name : String(mm.id ?? ''),
          free: isFreeCost(mm.cost),
          providerID: p.id,
          variants: modelVariants(mm.variants)
        }
      })
      .filter((m) => Boolean(m.id))
  }
  if (typeof models === 'object') {
    return Object.entries(models as unknown as Record<string, unknown>).map(([id, value]) => {
      const mm = (value ?? {}) as { name?: unknown; cost?: unknown; variants?: unknown }
      return {
        id,
        name: typeof mm.name === 'string' ? mm.name : id,
        free: isFreeCost(mm.cost),
        providerID: p.id,
        variants: modelVariants(mm.variants)
      }
    })
  }
  return []
}

function modelVariants(variants?: unknown): string[] {
  if (variants && typeof variants === 'object') {
    return Object.keys(variants as Record<string, unknown>)
  }
  return []
}

export const OpenCode = {
  listBackends: () => backendRequest<BackendDescriptor[]>({ type: 'backend.list' }),
  backendAuthStatus: () => backendRequest<BackendAuthStatus[]>({ type: 'backend.auth.status' }),
  setBackendDefaults: (defaults: Partial<Record<BackendId, BackendModelPreference>>) =>
    backendRequest<void>({ type: 'backend.defaults.set', defaults }),
  backendBinaries: () => backendRequest<Partial<Record<BackendId, string>>>({ type: 'backend.bin.get' }),
  setBackendBinary: (backendId: BackendId, path: string) =>
    backendRequest<Partial<Record<BackendId, string>>>({ type: 'backend.bin.set', backendId, path }),
  restartBackend: (backendId: BackendId) =>
    backendRequest<BackendDescriptor[]>({ type: 'backend.restart', backendId }),
  listSessions: () => backendRequest<SessionInfo[]>({ type: 'thread.list' }),
  createSession: (title?: string, backendId: BackendId = 'opencode', scope: ThreadCreationScope = 'current') =>
    backendRequest<SessionInfo>({ type: 'thread.create', backendId, title, scope }),
  createSessionInPath: (executionPath: string, title?: string, backendId: BackendId = 'opencode') =>
    backendRequest<SessionInfo>({ type: 'thread.create', backendId, title, executionPath }),
  setThreadBackend: (threadId: string, backendId: BackendId) =>
    backendRequest<SessionInfo>({ type: 'thread.backend.set', threadId, backendId }),
  deleteSession: (id: string) => backendRequest<void>({ type: 'thread.delete', threadId: id }),
  getSession: (id: string) => backendRequest<SessionInfo>({ type: 'thread.get', threadId: id }),
  renameSession: (id: string, title: string) =>
    backendRequest<SessionInfo>({ type: 'thread.rename', threadId: id, title }),
  listMessages: (id: string, limit?: number) =>
    backendRequest<MessageWithParts[]>({ type: 'thread.messages', threadId: id, limit }),
  sendMessageAsync: (id: string, parts: unknown[], opts?: BackendMessageOptions) =>
    backendRequest<void>({ type: 'thread.send', threadId: id, parts, options: opts }),
  followUps: (id: string) =>
    backendRequest<QueuedFollowUp[]>({ type: 'thread.followups.list', threadId: id }),
  addFollowUp: (id: string, text: string, attachments?: QueuedFollowUpAttachment[], options?: BackendMessageOptions) =>
    backendRequest<QueuedFollowUp[]>({ type: 'thread.followups.add', threadId: id, text, attachments, options }),
  updateFollowUp: (id: string, followUpId: string, text: string) =>
    backendRequest<QueuedFollowUp[]>({ type: 'thread.followups.update', threadId: id, followUpId, text }),
  removeFollowUp: (id: string, followUpId: string) =>
    backendRequest<QueuedFollowUp[]>({ type: 'thread.followups.remove', threadId: id, followUpId }),
  moveFollowUp: (id: string, followUpId: string, toIndex: number) =>
    backendRequest<QueuedFollowUp[]>({ type: 'thread.followups.move', threadId: id, followUpId, toIndex }),
  steerFollowUp: (id: string, followUpId: string) =>
    backendRequest<QueuedFollowUp[]>({ type: 'thread.followups.steer', threadId: id, followUpId }),
  abort: (id: string) => backendRequest<void>({ type: 'thread.abort', threadId: id }),
  revertMessage: (id: string, messageID: string) =>
    backendRequest<void>({ type: 'thread.revert', threadId: id, messageId: messageID }),
  unrevert: (id: string) => backendRequest<void>({ type: 'thread.unrevert', threadId: id }),
  fork: (id: string, messageID?: string) =>
    backendRequest<SessionInfo>({ type: 'thread.fork', threadId: id, messageId: messageID }),
  diff: (id: string, messageID?: string) =>
    backendRequest<FileDiff[]>({ type: 'thread.diff', threadId: id, messageId: messageID }),
  todos: (id: string) => backendRequest<Todo[]>({ type: 'thread.todos', threadId: id }),
  setThreadMode: (threadId: string, mode: BackendModeId) =>
    backendRequest<SessionInfo & { pendingUntilNextMessage?: boolean }>({ type: 'thread.mode.set', threadId, mode }),
  respondPermission: (sessionID: string, permissionID: string, response: 'once' | 'always' | 'reject') =>
    backendRequest<void>({ type: 'thread.permission', threadId: sessionID, permissionId: permissionID, response }),
  replyQuestion: (requestID: string, answers: string[][]) =>
    request<boolean>('POST', `/question/${requestID}/reply`, { body: { answers } }),
  rejectQuestion: (requestID: string) => request<boolean>('POST', `/question/${requestID}/reject`),
  replyQuestionToThread: (threadId: string, requestId: string, answers: string[][]) =>
    backendRequest<void>({ type: 'thread.question', threadId, requestId, answers }),
  summarize: (id: string, model?: { providerID: string; modelID: string }) =>
    backendRequest<void>({ type: 'thread.compact', threadId: id, model }),
  backendModels: (threadId?: string, backendId?: BackendId) =>
    backendRequest<BackendModelDescriptor[]>({ type: 'thread.models', threadId, backendId }),
  threadTitleSettings: () => backendRequest<ThreadTitleSettings>({ type: 'thread.title.settings.get' }),
  setThreadTitleSettings: (autoNameFromFirstPrompt: boolean) =>
    backendRequest<ThreadTitleSettings>({ type: 'thread.title.settings.set', autoNameFromFirstPrompt }),
  sandboxSettings: () => backendRequest<SandboxSettings>({ type: 'sandbox.settings.get' }),
  setSandboxSettings: (networkAccess: boolean) =>
    backendRequest<SandboxSettings>({ type: 'sandbox.settings.set', networkAccess }),
  supervision: () => backendRequest<SupervisionSnapshot>({ type: 'supervision.snapshot' }),
  searchTranscripts: (query: string, limit = 40) =>
    backendRequest<TranscriptSearchResult[]>({ type: 'supervision.search', query, limit }),
  acknowledgeAttention: (threadId: string) =>
    backendRequest<SupervisionSnapshot>({ type: 'supervision.acknowledge', threadId }),
  taskPolicy: (threadId: string) =>
    backendRequest<TaskPolicy | undefined>({ type: 'thread.policy.get', threadId }),
  setTaskPolicy: (threadId: string, policy: TaskPolicy) =>
    backendRequest<TaskPolicy>({ type: 'thread.policy.set', threadId, policy }),
  cloneToBackend: (threadId: string, backendId: BackendId, instruction?: string, options?: BackendMessageOptions) =>
    backendRequest<SessionInfo>({ type: 'thread.clone', threadId, backendId, instruction, options }),
  delegate: (threadId: string, backendId: BackendId, instruction: string, placement: DelegatePlacement, options?: BackendMessageOptions) =>
    backendRequest<SessionInfo>({ type: 'thread.delegate', threadId, backendId, instruction, placement, options }),
  fanOut: (threadId: string, task: string, workers: FanOutWorker[], options?: BackendMessageOptions) =>
    backendRequest<SessionInfo[]>({ type: 'thread.fanOut', threadId, task, workers, options }),
  forkIntoWorktree: (threadId: string, instruction?: string, options?: BackendMessageOptions) =>
    backendRequest<SessionInfo>({ type: 'thread.worktree.create', threadId, instruction, options }),
  listWorktrees: (threadId?: string) =>
    backendRequest<WorktreeInfo[]>({ type: 'worktree.list', threadId }),
  worktreeSettings: () =>
    backendRequest<WorktreeSettings>({ type: 'worktree.settings.get' }),
  setWorktreeSettings: (patch: Partial<WorktreeSettings>) =>
    backendRequest<WorktreeSettings>({ type: 'worktree.settings.set', ...patch }),
  removeWorktree: (worktreeId: string) =>
    backendRequest<WorktreeInfo>({ type: 'worktree.remove', worktreeId }),
  mcpList: () => backendRequest<McpConnectionView[]>({ type: 'mcp.list' }),
  mcpAdd: (input: McpConnectionInput) => backendRequest<McpConnectionView>({ type: 'mcp.add', input }),
  mcpUpdate: (connectionId: string, patch: Partial<McpConnectionInput> & { enabled?: boolean }) =>
    backendRequest<McpConnectionView>({ type: 'mcp.update', connectionId, patch }),
  mcpRemove: (connectionId: string) => backendRequest<void>({ type: 'mcp.remove', connectionId }),
  mcpImportScan: () => backendRequest<McpImportCandidate[]>({ type: 'mcp.import.scan' }),
  notifyWebhook: () => backendRequest<WebhookSettings>({ type: 'automation.webhook.get' }),
  setNotifyWebhook: (url: string) => backendRequest<WebhookSettings>({ type: 'automation.webhook.set', url }),
  setNotifyWebhookOnlyWhenAway: (onlyWhenAway: boolean) =>
    backendRequest<WebhookSettings>({ type: 'automation.webhook.set', onlyWhenAway }),
  remoteStatus: () => backendRequest<RemoteAccessStatus>({ type: 'remote.status' }),
  remoteSet: (patch: { enabled?: boolean; relayUrl?: string; forgetDeviceId?: string; revokeAll?: boolean }) =>
    backendRequest<RemoteAccessStatus>({ type: 'remote.set', patch }),
  remotePair: () => backendRequest<RemoteAccessStatus>({ type: 'remote.pair' }),
  remotePairCancel: () => backendRequest<RemoteAccessStatus>({ type: 'remote.pair.cancel' }),
  mobileStatus: () => backendRequest<MobileAccessStatus>({ type: 'mobile.status' }),
  mobileSet: (patch: { enabled?: boolean; port?: number; tailscale?: boolean; regenerateToken?: boolean; regenerateViewerToken?: boolean }) =>
    backendRequest<MobileAccessStatus>({ type: 'mobile.set', patch }),
  automationsList: () => backendRequest<AutomationsSnapshot>({ type: 'automation.list' }),
  createAutomation: (input: AutomationInput) => backendRequest<Automation>({ type: 'automation.create', input }),
  updateAutomation: (automationId: string, patch: Partial<AutomationInput> & { enabled?: boolean }) =>
    backendRequest<Automation>({ type: 'automation.update', automationId, patch }),
  deleteAutomation: (automationId: string) => backendRequest<void>({ type: 'automation.delete', automationId }),
  runAutomation: (automationId: string) => backendRequest<void>({ type: 'automation.run', automationId }),
  stopAutomation: (automationId: string) => backendRequest<void>({ type: 'automation.stop', automationId }),
  relayToThread: (sourceThreadId: string, targetThreadId: string, instruction?: string) =>
    backendRequest<SessionInfo>({ type: 'thread.relay', sourceThreadId, targetThreadId, instruction }),
  threadBus: (threadId?: string) =>
    backendRequest<ThreadBusSnapshot>({ type: 'thread.bus.get', threadId }),
  setThreadBusPolicy: (policy: CollaborationPolicy | null, projectId: string) =>
    backendRequest<ThreadBusSnapshot>({ type: 'thread.bus.policy', policy, projectId }),
  setThreadBusDefaultPolicy: (policy: CollaborationPolicy, threadId?: string) =>
    backendRequest<ThreadBusSnapshot>({ type: 'thread.bus.default-policy', policy, threadId }),
  clearThreadBusFailures: (threadId?: string) =>
    backendRequest<ThreadBusSnapshot>({ type: 'thread.bus.clear-failures', threadId }),
  qaPolicy: (threadId: string) =>
    backendRequest<QaPolicyState>({ type: 'thread.qa.get', threadId }),
  setQaPolicy: (threadId: string, policy: QaPolicy | null) =>
    backendRequest<QaPolicyState>({ type: 'thread.qa.policy', threadId, policy }),
  qaDefault: () => backendRequest<QaPolicy>({ type: 'qa.default.get' }),
  setQaDefault: (policy: QaPolicy) => backendRequest<QaPolicy>({ type: 'qa.default.policy', policy }),
  fileTree: (path = '', directory?: string) => request<FileNode[]>('GET', '/file', { query: { path }, directory }),
  fileContent: (path: string, directory?: string) => request<FileContent>('GET', '/file/content', { query: { path }, directory }),
  projectCurrent: () => request<Project>('GET', '/project/current'),
  agents: () => request<Agent[]>('GET', '/agent'),
  providers: () =>
    request<{ all: Provider[]; default: Record<string, string>; connected?: string[] }>('GET', '/provider'),
  config: () => request<ConfigInfo>('GET', '/config'),
  listCommands: () => request<Command[]>('GET', '/command'),
  runCommand: (id: string, command: string, args: string, opts?: BackendMessageOptions) =>
    backendRequest<MessageWithParts>({ type: 'thread.command', threadId: id, command, arguments: args, options: opts }),
  findFile: (q: string) => request<string[]>('GET', '/find/file', { query: { query: q } })
}
