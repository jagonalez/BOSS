import { OpenCodeServer } from '../opencode-server'
import { ApiClient } from '../api-client'
import { EventStream } from '../event-stream'
import type { Backend, McpServerConfig, ModelInfo, ThinkingLevel } from './backend'
import type { BackendMessageOptions } from '@shared/backend'
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

  supportsMcp(): boolean {
    return true
  }

  async registerMcpServer(name: string, config: McpServerConfig): Promise<boolean> {
    const res = await this.api.request({ method: 'POST', path: '/mcp', body: { name, config } })
    return res.status >= 200 && res.status < 300
  }

  async unregisterMcpServer(_name: string): Promise<void> {
    // opencode has no MCP remove endpoint; leave the server registered
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
    // adapt { all: Provider[] } -> ModelInfo[]
    const body = res.body as { all?: Array<{ id: string; models?: Array<{ id: string; name?: string }> }> }
    return (body.all ?? []).flatMap((p) =>
      (p.models ?? []).map((m) => ({ id: m.id, name: m.name, provider: p.id }))
    )
  }

  async modelSelect(_providerId: string, _modelId: string): Promise<void> {
    // opencode has no global select; per-message. Stub.
  }

  /* Thinking */
  async thinkingGet(): Promise<ThinkingLevel> { return { level: 'medium' } }
  async thinkingSet(_level: ThinkingLevel['level']): Promise<void> { /* opencode config */ }

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

  async runCommand(sessionId: string, command: string, args: string, opts?: BackendMessageOptions): Promise<MessageWithParts> {
    const res = await this.api.request({
      method: 'POST',
      path: `/session/${sessionId}/command`,
      body: { command, arguments: args, agent: opts?.agent, model: opts?.model }
    })
    return res.body as MessageWithParts
  }

  async compact(sessionId: string, model?: { providerID: string; modelID: string }): Promise<void> {
    if (!model) throw new Error('OpenCode compaction requires a model selection.')
    await this.api.request({ method: 'POST', path: `/session/${sessionId}/summarize`, body: model })
  }
}
