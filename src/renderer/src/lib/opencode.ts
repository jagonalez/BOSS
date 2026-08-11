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
import type { BackendDescriptor, BackendId, BackendMessageOptions, BackendRequest } from '@shared/backend'

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    detail: unknown
  ) {
    super(`${path} -> ${status}: ${JSON.stringify(detail)}`)
  }
}

async function request<T>(method: HttpMethod, path: string, opts?: { query?: Record<string, string | number | boolean | undefined>; body?: unknown }): Promise<T> {
  const res = await window.ralf.apiRequest({
    method,
    path,
    query: opts?.query,
    body: opts?.body
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
  return window.ralf.backendRequest(req) as Promise<T>
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
  listSessions: () => backendRequest<SessionInfo[]>({ type: 'thread.list' }),
  createSession: (title?: string, backendId: BackendId = 'opencode') =>
    backendRequest<SessionInfo>({ type: 'thread.create', backendId, title }),
  deleteSession: (id: string) => backendRequest<void>({ type: 'thread.delete', threadId: id }),
  getSession: (id: string) => backendRequest<SessionInfo>({ type: 'thread.get', threadId: id }),
  renameSession: (id: string, title: string) =>
    backendRequest<SessionInfo>({ type: 'thread.rename', threadId: id, title }),
  listMessages: (id: string, limit?: number) =>
    backendRequest<MessageWithParts[]>({ type: 'thread.messages', threadId: id, limit }),
  sendMessage: (id: string, parts: unknown[], opts?: { model?: string; agent?: string }) =>
    request<MessageWithParts>('POST', `/session/${id}/message`, { body: { parts, ...opts } }),
  sendMessageAsync: (id: string, parts: unknown[], opts?: BackendMessageOptions) =>
    backendRequest<void>({ type: 'thread.send', threadId: id, parts, options: opts }),
  abort: (id: string) => backendRequest<void>({ type: 'thread.abort', threadId: id }),
  revertMessage: (id: string, messageID: string) =>
    request<SessionInfo>('POST', `/session/${id}/revert`, { body: { messageID } }),
  unrevert: (id: string) => request<SessionInfo>('POST', `/session/${id}/unrevert`),
  fork: (id: string, messageID?: string) =>
    backendRequest<SessionInfo>({ type: 'thread.fork', threadId: id, messageId: messageID }),
  diff: (id: string, messageID?: string) =>
    backendRequest<FileDiff[]>({ type: 'thread.diff', threadId: id, messageId: messageID }),
  todos: (id: string) => backendRequest<Todo[]>({ type: 'thread.todos', threadId: id }),
  respondPermission: (sessionID: string, permissionID: string, response: 'once' | 'always' | 'reject') =>
    backendRequest<void>({ type: 'thread.permission', threadId: sessionID, permissionId: permissionID, response }),
  replyQuestion: (requestID: string, answers: string[][]) =>
    request<boolean>('POST', `/question/${requestID}/reply`, { body: { answers } }),
  rejectQuestion: (requestID: string) => request<boolean>('POST', `/question/${requestID}/reject`),
  shell: (id: string, command: string, opts?: { model?: string; agent?: string }) =>
    request<MessageWithParts>('POST', `/session/${id}/shell`, { body: { command, ...opts } }),
  summarize: (id: string, model?: { providerID: string; modelID: string }) =>
    backendRequest<void>({ type: 'thread.compact', threadId: id, model }),
  backendModels: (threadId?: string, backendId?: BackendId) =>
    backendRequest<Array<{ id: string; name?: string; provider?: string }>>({ type: 'thread.models', threadId, backendId }),
  cloneToBackend: (threadId: string, backendId: BackendId, instruction?: string) =>
    backendRequest<SessionInfo>({ type: 'thread.clone', threadId, backendId, instruction }),
  relayToThread: (sourceThreadId: string, targetThreadId: string, instruction?: string) =>
    backendRequest<SessionInfo>({ type: 'thread.relay', sourceThreadId, targetThreadId, instruction }),
  fileTree: (path = '') => request<FileNode[]>('GET', '/file', { query: { path } }),
  fileContent: (path: string) => request<FileContent>('GET', '/file/content', { query: { path } }),
  projectList: () => request<Project[]>('GET', '/project'),
  projectCurrent: () => request<Project>('GET', '/project/current'),
  agents: () => request<Agent[]>('GET', '/agent'),
  providers: () =>
    request<{ all: Provider[]; default: Record<string, string>; connected?: string[] }>('GET', '/provider'),
  config: () => request<ConfigInfo>('GET', '/config'),
  listCommands: () => request<Command[]>('GET', '/command'),
  runCommand: (id: string, command: string, args: string, opts?: { agent?: string; model?: { providerID: string; modelID: string; variant?: string } }) =>
    request<MessageWithParts>('POST', `/session/${id}/command`, { body: { command, arguments: args, ...opts } }),
  findFile: (q: string) => request<string[]>('GET', '/find/file', { query: { query: q } })
}
