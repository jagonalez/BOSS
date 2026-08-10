import { OpenCodeServer } from '../opencode-server'
import { ApiClient } from '../api-client'
import { EventStream } from '../event-stream'
import type { Backend, ModelInfo } from './backend'
import type { SessionInfo, MessageWithParts, Todo, FileDiff, FileNode, FileContent, EventMessage } from '@shared/opencode'

export class OpenCodeBackend implements Backend {
  readonly id = 'opencode' as const
  private eventCb?: (ev: EventMessage) => void

  constructor(
    private server: OpenCodeServer,
    private api: ApiClient,
    private events: EventStream
  ) {
    // wire normalized events from EventStream -> EventMessage
    this.events.onEvent = (raw) => {
      try {
        const ev = JSON.parse(raw) as unknown
        // EventMessage is the canonical shape; pass through
        this.eventCb?.(ev as EventMessage)
      } catch {
        this.eventCb?.({ type: 'unknown', raw })
      }
    }
  }

  async start(): Promise<void> {
    await this.server.start()
    this.events.start()
  }

  async stop(): Promise<void> {
    this.events.stop()
    await this.server.stop()
  }

  async setProject(path: string): Promise<void> {
    await this.server.setProject(path)
  }

  info() {
    const s = this.server.info
    return {
      id: this.id,
      engine: 'opencode',
      version: s.version,
      healthy: s.healthy,
      projectPath: this.server.projectPath,
    }
  }

  onEvent(cb: (ev: EventMessage) => void): () => void {
    this.eventCb = cb
    return () => { this.eventCb = undefined }
  }

  /* Sessions – map to existing OpenCode HTTP API */
  async sessionsList(): Promise<SessionInfo[]> {
    const res = await this.api.request({ method: 'GET', path: '/session' })
    return res.body as SessionInfo[]
  }

  async sessionCreate(title?: string): Promise<SessionInfo> {
    const res = await this.api.request({ method: 'POST', path: '/session', body: title ? { title } : {} })
    return res.body as SessionInfo
  }

  async sessionDelete(id: string): Promise<void> {
    await this.api.request({ method: 'DELETE', path: `/session/${id}` })
  }

  async sessionRename(id: string, title: string): Promise<SessionInfo> {
    const res = await this.api.request({ method: 'PATCH', path: `/session/${id}`, body: { title } })
    return res.body as SessionInfo
  }

  async sessionGet(id: string): Promise<SessionInfo> {
    const res = await this.api.request({ method: 'GET', path: `/session/${id}` })
    return res.body as SessionInfo
  }

  /* Messages */
  async messagesList(sessionId: string, limit?: number): Promise<MessageWithParts[]> {
    const res = await this.api.request({
      method: 'GET',
      path: `/session/${sessionId}/message`,
      query: limit ? { limit: String(limit) } : undefined
    })
    return res.body as MessageWithParts[]
  }

  async sendMessage(sessionId: string, parts: unknown[], opts?: any): Promise<void> {
    await this.api.request({
      method: 'POST',
      path: `/session/${sessionId}/prompt_async`,
      body: { parts, ...opts }
    })
  }

  async abort(sessionId: string): Promise<void> {
    await this.api.request({ method: 'POST', path: `/session/${sessionId}/abort` })
  }

  /* Models */
  async modelsList(): Promise<ModelInfo[]> {
    const res = await this.api.request({ method: 'GET', path: '/provider' })
    // adapt Provider[] -> ModelInfo[]
    return []
  }

  async modelSelect(providerId: string, modelId: string): Promise<void> {
    // opencode has no global select; per-message. Stub.
  }

  /* Thinking */
  async thinkingGet(): Promise<{level:string}> { return { level: 'medium' } }
  async thinkingSet(level: string): Promise<void> { /* opencode config */ }

  /* Todos / Permissions */
  async todosGet(sessionId: string): Promise<Todo[]> {
    const res = await this.api.request({ method: 'GET', path: `/session/${sessionId}/todo` })
    return res.body as Todo[]
  }

  async permissionRespond(sessionId: string, permissionId: string, response: 'once'|'always'|'reject'): Promise<void> {
    await this.api.request({
      method: 'POST',
      path: `/session/${sessionId}/permissions/${permissionId}`,
      body: { response }
    })
  }

  /* Files / Diff */
  async diffGet(sessionId: string, messageId?: string): Promise<FileDiff[]> {
    const res = await this.api.request({
      method: 'GET',
      path: `/session/${sessionId}/diff`,
      query: messageId ? { messageID: messageId } : undefined
    })
    return res.body as FileDiff[]
  }

  async fileTree(path?: string): Promise<FileNode[]> {
    const res = await this.api.request({ method: 'GET', path: '/file', query: { path: path ?? '' } })
    return res.body as FileNode[]
  }

  async fileContent(path: string): Promise<FileContent> {
    const res = await this.api.request({ method: 'GET', path: '/file/content', query: { path } })
    return res.body as FileContent
  }

  /* Fork / Revert */
  async fork(sessionId: string, messageId?: string): Promise<SessionInfo> {
    const res = await this.api.request({
      method: 'POST',
      path: `/session/${sessionId}/fork`,
      body: messageId ? { messageID: messageId } : {}
    })
    return res.body as SessionInfo
  }

  async revert(sessionId: string, messageId: string): Promise<void> {
    await this.api.request({ method: 'POST', path: `/session/${sessionId}/revert`, body: { messageID: messageId } })
  }

  async unrevert(sessionId: string): Promise<void> {
    await this.api.request({ method: 'POST', path: `/session/${sessionId}/unrevert` })
  }
}
