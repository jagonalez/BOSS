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
  listSessions: () => request<SessionInfo[]>('GET', '/session'),
  createSession: (title?: string) =>
    request<SessionInfo>('POST', '/session', { body: title ? { title } : {} }),
  deleteSession: (id: string) => request<boolean>('DELETE', `/session/${id}`),
  getSession: (id: string) => request<SessionInfo>('GET', `/session/${id}`),
  renameSession: (id: string, title: string) =>
    request<SessionInfo>('PATCH', `/session/${id}`, { body: { title } }),
  listMessages: (id: string, limit?: number) =>
    request<MessageWithParts[]>('GET', `/session/${id}/message`, { query: { limit } }),
  sendMessage: (id: string, parts: unknown[], opts?: { model?: string; agent?: string }) =>
    request<MessageWithParts>('POST', `/session/${id}/message`, { body: { parts, ...opts } }),
  sendMessageAsync: (id: string, parts: unknown[], opts?: { model?: { providerID: string; modelID: string; variant?: string }; agent?: string }) =>
    request<unknown>('POST', `/session/${id}/prompt_async`, { body: { parts, ...opts } }),
  abort: (id: string) => request<boolean>('POST', `/session/${id}/abort`),
  revertMessage: (id: string, messageID: string) =>
    request<SessionInfo>('POST', `/session/${id}/revert`, { body: { messageID } }),
  unrevert: (id: string) => request<SessionInfo>('POST', `/session/${id}/unrevert`),
  fork: (id: string, messageID?: string) =>
    request<SessionInfo>('POST', `/session/${id}/fork`, { body: messageID ? { messageID } : {} }),
  diff: (id: string, messageID?: string) =>
    request<FileDiff[]>('GET', `/session/${id}/diff`, { query: { messageID } }),
  todos: (id: string) => request<Todo[]>('GET', `/session/${id}/todo`),
  respondPermission: (sessionID: string, permissionID: string, response: 'once' | 'always' | 'reject') =>
    request<boolean>('POST', `/session/${sessionID}/permissions/${permissionID}`, { body: { response } }),
  replyQuestion: (requestID: string, answers: string[][]) =>
    request<boolean>('POST', `/question/${requestID}/reply`, { body: { answers } }),
  rejectQuestion: (requestID: string) => request<boolean>('POST', `/question/${requestID}/reject`),
  shell: (id: string, command: string, opts?: { model?: string; agent?: string }) =>
    request<MessageWithParts>('POST', `/session/${id}/shell`, { body: { command, ...opts } }),
  summarize: (id: string, model: { providerID: string; modelID: string }) =>
    request<boolean>('POST', `/session/${id}/summarize`, { body: model }),
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
