import type { HttpMethod } from '@shared/ipc'
import type {
  Agent,
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
}

export function providerModels(p: Provider): ModelOption[] {
  const models = p.models
  if (!models) return []
  if (Array.isArray(models)) {
    return models
      .map((m) => (typeof m === 'string' ? { id: m } : { id: String((m as { id?: unknown })?.id ?? '') }))
      .filter((m) => Boolean(m.id))
  }
  if (typeof models === 'object') {
    return Object.keys(models as Record<string, unknown>).map((id) => ({ id }))
  }
  return []
}

export const OpenCode = {
  listSessions: () => request<SessionInfo[]>('GET', '/session'),
  createSession: (title?: string) =>
    request<SessionInfo>('POST', '/session', { body: title ? { title } : {} }),
  deleteSession: (id: string) => request<boolean>('DELETE', `/session/${id}`),
  getSession: (id: string) => request<SessionInfo>('GET', `/session/${id}`),
  listMessages: (id: string, limit?: number) =>
    request<MessageWithParts[]>('GET', `/session/${id}/message`, { query: { limit } }),
  sendMessage: (id: string, parts: unknown[], opts?: { model?: string; agent?: string }) =>
    request<MessageWithParts>('POST', `/session/${id}/message`, { body: { parts, ...opts } }),
  sendMessageAsync: (id: string, parts: unknown[], opts?: { model?: string; agent?: string }) =>
    request<unknown>('POST', `/session/${id}/prompt_async`, { body: { parts, ...opts } }),
  abort: (id: string) => request<boolean>('POST', `/session/${id}/abort`),
  fork: (id: string, messageID?: string) =>
    request<SessionInfo>('POST', `/session/${id}/fork`, { body: messageID ? { messageID } : {} }),
  diff: (id: string, messageID?: string) =>
    request<FileDiff[]>('GET', `/session/${id}/diff`, { query: { messageID } }),
  todos: (id: string) => request<Todo[]>('GET', `/session/${id}/todo`),
  respondPermission: (sessionID: string, permissionID: string, response: string, remember?: boolean) =>
    request<boolean>('POST', `/session/${sessionID}/permissions/${permissionID}`, { body: { response, remember } }),
  shell: (id: string, command: string, opts?: { model?: string; agent?: string }) =>
    request<MessageWithParts>('POST', `/session/${id}/shell`, { body: { command, ...opts } }),
  fileTree: (path?: string) => request<FileNode[]>('GET', '/file', { query: { path } }),
  fileContent: (path: string) => request<FileContent>('GET', '/file/content', { query: { path } }),
  projectList: () => request<Project[]>('GET', '/project'),
  projectCurrent: () => request<Project>('GET', '/project/current'),
  agents: () => request<Agent[]>('GET', '/agent'),
  providers: () => request<{ all: Provider[]; default: Record<string, string> }>('GET', '/provider'),
  config: () => request<ConfigInfo>('GET', '/config'),
  findFile: (q: string) => request<string[]>('GET', '/find/file', { query: { query: q } })
}
