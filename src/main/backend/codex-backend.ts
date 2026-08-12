import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { Backend, McpServerConfig, ModelInfo, ThinkingLevel } from './backend'
import type { BackendMessageOptions } from '@shared/backend'
import type { ThreadBusAgentTool, ThreadBusToolCall } from '@shared/thread-bus'
import { QA_GUIDANCE, QA_TOOL_DEFINITIONS, isAgentToolResult } from '@shared/qa'
import { TEAM_AGENT_TOOL_DEFINITIONS } from '@shared/team'
import type { EventMessage, SessionInfo, MessageWithParts, Todo, FileDiff, FileNode, FileContent, Part } from '@shared/opencode'

type RpcId = string | number
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }

interface CodexThread {
  id: string
  preview?: string
  name?: string | null
  cwd?: string
  createdAt?: number
  updatedAt?: number
  turns?: CodexTurn[]
}

interface CodexTurn {
  id: string
  status?: string
  startedAt?: number | null
  completedAt?: number | null
  items?: CodexItem[]
}

interface CodexItem {
  id: string
  type: string
  text?: string
  content?: Array<{ type?: string; text?: string }>
  command?: string
  cwd?: string
  status?: string
  aggregatedOutput?: string | null
  changes?: Array<{ path?: string; kind?: string; diff?: string }>
  summary?: string[]
  tool?: string
  arguments?: unknown
  result?: unknown
  error?: unknown
  name?: string
  input?: unknown
  call_id?: string
  callId?: string
  output?: unknown
  contentItems?: Array<{ type?: string; text?: string; imageUrl?: string }>
  durationMs?: number | null
  success?: boolean | null
  namespace?: string | null
}

interface PendingApproval {
  rpcId: RpcId
  method: string
  params: Record<string, unknown>
}

const THREAD_BUS_TOOLS: Array<Record<string, unknown>> = [
  {
    type: 'function',
    name: 'ralf_threads_list',
    description: 'List other R.A.L.F. threads in this project that use the same backend.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    type: 'function',
    name: 'ralf_threads_read',
    description: 'Read a bounded recent transcript from another same-project, same-backend R.A.L.F. thread.',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string', description: 'R.A.L.F. thread id returned by ralf_threads_list.' },
        limit: { type: 'number', description: 'Number of recent messages to read, from 1 to 20.' }
      },
      required: ['threadId'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'ralf_threads_send',
    description: 'Send a durable message to another same-project, same-backend R.A.L.F. thread. Busy targets queue the message.',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string', description: 'Target R.A.L.F. thread id.' },
        message: { type: 'string', description: 'Concise context, question, or requested task.' },
        expectsReply: { type: 'boolean', description: 'Whether the target should reply.' },
        maxTurns: { type: 'number', description: 'Maximum messages in this exchange, from 1 to 8.' }
      },
      required: ['threadId', 'message'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'ralf_threads_reply',
    description: 'Reply to a R.A.L.F. thread message addressed to this thread.',
    inputSchema: {
      type: 'object',
      properties: {
        messageId: { type: 'string', description: 'Message id included in the incoming R.A.L.F. message.' },
        message: { type: 'string', description: 'Reply for the sending thread.' },
        expectsReply: { type: 'boolean', description: 'Whether another response is useful.' }
      },
      required: ['messageId', 'message'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'ralf_threads_spawn_worktree',
    description: 'Fork this conversation into a new R.A.L.F. thread running in an isolated Git worktree.',
    inputSchema: {
      type: 'object',
      properties: {
        instruction: { type: 'string', description: 'Concrete implementation task for the new worktree thread.' }
      },
      required: ['instruction'],
      additionalProperties: false
    }
  },
  ...TEAM_AGENT_TOOL_DEFINITIONS.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema
  })),
  ...QA_TOOL_DEFINITIONS.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema
  })),
  {
    type: 'function',
    name: 'ralf_mcp_list',
    description: 'List external MCP tools available through R.A.L.F. connections (Slack, Datadog, and other services). Pass tool to get one tool\'s full input schema before calling it.',
    inputSchema: {
      type: 'object',
      properties: { tool: { type: 'string', description: 'Optional: tool name from the catalog; returns its full input schema.' } },
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'ralf_mcp_call',
    description: 'Call an external MCP tool listed by ralf_mcp_list.',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'Tool name from ralf_mcp_list.' },
        arguments: { type: 'object', description: 'Arguments for the tool.', additionalProperties: true }
      },
      required: ['tool'],
      additionalProperties: false
    }
  }
]

function threadInfo(thread: CodexThread): SessionInfo {
  return {
    id: thread.id,
    title: thread.name || thread.preview || 'Untitled Codex thread',
    directory: thread.cwd,
    time: {
      created: thread.createdAt ? thread.createdAt * 1000 : undefined,
      updated: thread.updatedAt ? thread.updatedAt * 1000 : undefined
    }
  }
}

function userText(content?: CodexItem['content']): string {
  return (content ?? []).filter((item) => item.type === 'text').map((item) => item.text ?? '').join('\n')
}

function userInputs(parts: unknown[]): Array<Record<string, unknown>> {
  const inputs: Array<Record<string, unknown>> = []
  const text: string[] = []
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue
    const item = part as { type?: string; text?: string; filename?: string; mime?: string; url?: string }
    if (item.type === 'text' && item.text) text.push(item.text)
    else if (item.type === 'file' && item.mime?.startsWith('image/') && item.url) inputs.push({ type: 'image', url: item.url })
    else if (item.type === 'file') text.push(`[Attached file: ${item.filename ?? item.mime ?? 'file'}]`)
  }
  if (text.length) inputs.unshift({ type: 'text', text: text.join('\n'), text_elements: [] })
  return inputs
}

function dynamicToolOutput(item: CodexItem): unknown {
  if (!item.contentItems?.length) return item.result ?? item.error
  const text = item.contentItems
    .filter((entry) => entry.type === 'inputText' || entry.text)
    .map((entry) => entry.text ?? '')
    .filter(Boolean)
    .join('\n')
  const images = item.contentItems
    .filter((entry) => entry.type === 'inputImage' && entry.imageUrl)
    .map((entry) => entry.imageUrl)
  if (!images.length) return text
  return { text, images }
}

function itemPart(sessionId: string, messageId: string, item: CodexItem): Part | null {
  if (item.type === 'agentMessage' || item.type === 'plan') {
    return { id: item.id, type: 'text', sessionID: sessionId, messageID: messageId, text: item.text ?? '' }
  }
  if (item.type === 'reasoning') {
    // Blank line between summaries: single newlines collapse to spaces in markdown.
    return { id: item.id, type: 'reasoning', sessionID: sessionId, messageID: messageId, text: (item.summary ?? []).join('\n\n') }
  }
  // Codex wraps R.A.L.F.-provided tools (ralf_mcp_call, thread tools) in its
  // exec harness and reports them as custom tool call items.
  if (item.type === 'customToolCall' || item.type === 'custom_tool_call') {
    return {
      id: item.call_id ?? item.callId ?? item.id,
      type: 'tool',
      sessionID: sessionId,
      messageID: messageId,
      state: {
        status: item.status === 'failed' ? 'error' : item.status === 'completed' ? 'completed' : 'running',
        tool: item.name ?? 'tool',
        title: item.name,
        input: item.input
      }
    }
  }
  if (item.type === 'customToolCallOutput' || item.type === 'custom_tool_call_output') {
    const output = Array.isArray(item.output)
      ? (item.output as Array<{ text?: string }>).map((entry) => entry.text ?? '').filter(Boolean).join('\n')
      : item.output
    return {
      id: item.call_id ?? item.callId ?? item.id,
      type: 'tool',
      sessionID: sessionId,
      messageID: messageId,
      state: { status: 'completed', output }
    }
  }
  if (item.type === 'commandExecution') {
    return {
      id: item.id,
      type: 'tool',
      sessionID: sessionId,
      messageID: messageId,
      state: {
        status: item.status === 'completed' ? 'completed' : item.status === 'failed' ? 'error' : 'running',
        tool: 'shell',
        title: item.command,
        input: { command: item.command, cwd: item.cwd },
        output: item.aggregatedOutput
      }
    }
  }
  if (item.type === 'fileChange' || item.type === 'mcpToolCall' || item.type === 'dynamicToolCall' || item.type === 'collabAgentToolCall') {
    const completed = item.status === 'completed' || item.success !== null && item.success !== undefined
    return {
      id: item.id,
      type: 'tool',
      sessionID: sessionId,
      messageID: messageId,
      state: {
        status: item.status === 'failed' || item.success === false ? 'error' : completed ? 'completed' : 'running',
        tool: item.type === 'fileChange' ? 'fileChange' : item.tool ?? item.type,
        input: item.arguments ?? item.changes,
        output: item.type === 'dynamicToolCall' ? dynamicToolOutput(item) : item.result ?? item.error,
        metadata: item.type === 'dynamicToolCall'
          ? { durationMs: item.durationMs, namespace: item.namespace, success: item.success }
          : undefined
      }
    }
  }
  return null
}

function turnMessages(sessionId: string, turn: CodexTurn): MessageWithParts[] {
  const messages: MessageWithParts[] = []
  const user = (turn.items ?? []).find((item) => item.type === 'userMessage')
  if (user) {
    const id = user.id
    messages.push({
      info: { id, sessionID: sessionId, role: 'user', time: { created: turn.startedAt ? turn.startedAt * 1000 : undefined } },
      parts: [{ id: `${id}-text`, type: 'text', sessionID: sessionId, messageID: id, text: userText(user.content) }]
    })
  }
  const assistantItems = (turn.items ?? []).filter((item) => item.type !== 'userMessage' && item.type !== 'hookPrompt')
  if (assistantItems.length) {
    const id = `assistant-${turn.id}`
    messages.push({
      info: {
        id,
        sessionID: sessionId,
        role: 'assistant',
        time: {
          created: turn.startedAt ? turn.startedAt * 1000 : undefined,
          completed: turn.completedAt ? turn.completedAt * 1000 : undefined
        }
      },
      parts: assistantItems.map((item) => itemPart(sessionId, id, item)).filter(Boolean) as Part[]
    })
  }
  return messages
}

export class CodexBackend implements Backend {
  readonly id = 'codex' as const
  private process: ChildProcess | null = null
  private nextId = 1
  private pending = new Map<string, Pending>()
  private approvals = new Map<string, PendingApproval>()
  private loadedThreads = new Set<string>()
  private activeTurns = new Map<string, string>()
  private liveText = new Map<string, string>()
  private eventCb?: (event: EventMessage) => void
  private projectPath = ''
  private version = ''
  private healthy = false
  private buffer = ''
  private threadBusHandler?: (call: ThreadBusToolCall) => Promise<unknown>

  constructor(cwd?: string) {
    this.projectPath = cwd ?? ''
  }

  async start(): Promise<void> {
    if (this.process) return
    try {
      this.version = execFileSync('codex', ['--version'], { encoding: 'utf8', timeout: 2500 }).trim()
    } catch {
      throw new Error('Codex CLI is not installed or could not be started.')
    }
    this.process = spawn('codex', ['app-server', '--stdio'], {
      cwd: this.projectPath || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const decoder = new TextDecoder()
    this.process.stdout?.on('data', (chunk: Buffer) => {
      this.buffer += decoder.decode(chunk, { stream: true })
      let index = this.buffer.indexOf('\n')
      while (index >= 0) {
        const line = this.buffer.slice(0, index).replace(/\r$/, '')
        this.buffer = this.buffer.slice(index + 1)
        this.handleLine(line)
        index = this.buffer.indexOf('\n')
      }
    })
    this.process.stderr?.on('data', () => {})
    this.process.on('error', (error) => this.rejectAll(error))
    this.process.on('exit', () => {
      this.process = null
      this.healthy = false
      this.rejectAll(new Error('Codex app-server exited.'))
      this.emit({ type: 'server.disconnected' })
    })
    await this.request('initialize', {
      clientInfo: { name: 'ralf_desktop', title: 'R.A.L.F.', version: '0.1.0' },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false
      }
    })
    this.notify('initialized', {})
    this.healthy = true
  }

  async stop(): Promise<void> {
    this.process?.kill()
    this.process = null
    this.healthy = false
    this.rejectAll(new Error('Codex app-server stopped.'))
  }

  async setProject(path: string): Promise<void> {
    this.projectPath = path
  }

  info() {
    return { id: this.id, engine: 'codex-app-server', version: this.version, healthy: this.healthy, projectPath: this.projectPath }
  }

  supportsMcp(): boolean { return false }
  async registerMcpServer(_name: string, _config: McpServerConfig): Promise<boolean> { return false }
  async unregisterMcpServer(_name: string): Promise<void> {}

  setThreadBusHandler(handler: (call: ThreadBusToolCall) => Promise<unknown>): void {
    this.threadBusHandler = handler
  }

  onEvent(callback: (event: EventMessage) => void): () => void {
    this.eventCb = callback
    return () => { if (this.eventCb === callback) this.eventCb = undefined }
  }

  private emit(event: EventMessage): void { this.eventCb?.(event) }

  private request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (!this.process?.stdin) return Promise.reject(new Error('Codex app-server is not running.'))
    const id = String(this.nextId++)
    this.process.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex ${method} request timed out.`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
    })
  }

  private notify(method: string, params: unknown): void {
    this.process?.stdin?.write(`${JSON.stringify({ method, params })}\n`)
  }

  private respond(id: RpcId, result: unknown): void {
    this.process?.stdin?.write(`${JSON.stringify({ id, result })}\n`)
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private handleLine(line: string): void {
    if (!line.trim()) return
    let message: Record<string, unknown>
    try { message = JSON.parse(line) as Record<string, unknown> } catch { return }
    if (message.id !== undefined && !message.method) {
      const id = String(message.id)
      const pending = this.pending.get(id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(id)
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)))
      else pending.resolve(message.result)
      return
    }
    if (message.id !== undefined && typeof message.method === 'string') {
      this.handleServerRequest(message.id as RpcId, message.method, (message.params ?? {}) as Record<string, unknown>)
      return
    }
    if (typeof message.method === 'string') this.mapNotification(message.method, (message.params ?? {}) as Record<string, unknown>)
  }

  private handleServerRequest(id: RpcId, method: string, params: Record<string, unknown>): void {
    if (method === 'item/tool/call') {
      const tool = String(params.tool ?? '') as ThreadBusAgentTool
      if (!this.threadBusHandler || (!tool.startsWith('ralf_threads_') && !tool.startsWith('ralf_team_') && !tool.startsWith('ralf_browser_') && !tool.startsWith('ralf_mcp_') && tool !== 'ralf_computer')) {
        this.respond(id, { contentItems: [{ type: 'inputText', text: 'Unknown R.A.L.F. tool.' }], success: false })
        return
      }
      void this.threadBusHandler({
        nativeThreadId: String(params.threadId ?? ''),
        tool,
        arguments: params.arguments
      }).then((result) => {
        if (isAgentToolResult(result)) {
          this.respond(id, {
            contentItems: [
              { type: 'inputText', text: result.text },
              ...(result.image ? [{ type: 'inputImage', imageUrl: `data:${result.image.mimeType};base64,${result.image.data}` }] : [])
            ],
            success: true
          })
        } else {
          this.respond(id, { contentItems: [{ type: 'inputText', text: JSON.stringify(result, null, 2) }], success: true })
        }
      }).catch((error) => {
        this.respond(id, {
          contentItems: [{ type: 'inputText', text: error instanceof Error ? error.message : String(error) }],
          success: false
        })
      })
      return
    }
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval' || method === 'item/permissions/requestApproval') {
      const permissionId = String(id)
      this.approvals.set(permissionId, { rpcId: id, method, params })
      this.emit({
        type: 'permission.asked',
        permission: {
          id: permissionId,
          sessionID: String(params.threadId ?? ''),
          permission: method.includes('fileChange') ? 'edit' : method.includes('permissions') ? 'permissions' : 'shell',
          patterns: params.command ? [String(params.command)] : undefined,
          metadata: { method, reason: params.reason, cwd: params.cwd, requested: params.permissions },
          time: { created: Number(params.startedAtMs ?? Date.now()) }
        }
      })
      return
    }
    // R.A.L.F. cannot safely render these request types yet. Resolve them conservatively.
    if (method === 'item/tool/requestUserInput' || method === 'mcpServer/elicitation/request') {
      this.respond(id, { action: 'cancel', content: null })
    } else {
      this.respond(id, { decision: 'decline' })
    }
  }

  private mapNotification(method: string, params: Record<string, unknown>): void {
    const sessionId = String(params.threadId ?? '')
    switch (method) {
      case 'turn/started': {
        const turn = params.turn as CodexTurn | undefined
        if (turn?.id) this.activeTurns.set(sessionId, turn.id)
        this.emit({ type: 'session.status', sessionID: sessionId, status: { type: 'busy' } })
        break
      }
      case 'turn/completed': {
        const turn = params.turn as CodexTurn | undefined
        if (turn?.status === 'failed') this.emit({ type: 'session.error', sessionID: sessionId, error: JSON.stringify((turn as unknown as { error?: unknown }).error ?? 'Codex turn failed') })
        this.activeTurns.delete(sessionId)
        this.emit({ type: 'session.status', sessionID: sessionId, status: { type: 'idle' } })
        this.emit({ type: 'session.idle', sessionID: sessionId })
        break
      }
      case 'item/started':
      case 'item/completed': {
        const item = params.item as CodexItem | undefined
        if (!item) break
        const messageId = item.type === 'userMessage' ? item.id : `assistant-${String(params.turnId ?? '')}`
        if (item.type === 'userMessage') {
          this.emit({ type: 'message.updated', message: { id: messageId, sessionID: sessionId, role: 'user', time: { created: Number(params.startedAtMs ?? Date.now()) } } })
          this.emit({ type: 'message.part.updated', part: { id: `${messageId}-text`, type: 'text', sessionID: sessionId, messageID: messageId, text: userText(item.content) } })
        } else {
          this.emit({ type: 'message.updated', message: { id: messageId, sessionID: sessionId, role: 'assistant', time: { created: Number(params.startedAtMs ?? Date.now()) } } })
          const part = itemPart(sessionId, messageId, item)
          if (part) {
            this.emit({ type: 'message.part.updated', part })
          }
        }
        break
      }
      case 'item/agentMessage/delta': {
        const itemId = String(params.itemId ?? randomUUID())
        const messageId = `assistant-${String(params.turnId ?? '')}`
        const key = `${sessionId}:${itemId}`
        const text = `${this.liveText.get(key) ?? ''}${String(params.delta ?? '')}`
        this.liveText.set(key, text)
        this.emit({ type: 'message.updated', message: { id: messageId, sessionID: sessionId, role: 'assistant' } })
        this.emit({ type: 'message.part.updated', part: { id: itemId, type: 'text', sessionID: sessionId, messageID: messageId, text } })
        break
      }
      case 'thread/name/updated':
        this.emit({ type: 'session.updated', session: { id: sessionId, title: String(params.threadName ?? '') } })
        break
      case 'error':
        this.emit({ type: 'session.error', sessionID: sessionId, error: JSON.stringify(params.error ?? 'Codex error') })
        break
      case 'thread/compacted':
        this.emit({ type: 'session.compacted', sessionID: sessionId })
        break
    }
  }

  async sessionsList(): Promise<SessionInfo[]> {
    const result = await this.request('thread/list', { cwd: this.projectPath || undefined, limit: 100 }) as { data?: CodexThread[] }
    return (result.data ?? []).map(threadInfo)
  }

  async sessionCreate(title?: string, directory?: string): Promise<SessionInfo> {
    const params = {
      cwd: directory || this.projectPath || undefined,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      developerInstructions: QA_GUIDANCE,
      dynamicTools: THREAD_BUS_TOOLS
    }
    let result: { thread: CodexThread }
    try {
      result = await this.request('thread/start', params) as { thread: CodexThread }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!/dynamicTools|experimental|invalid params|unknown field|-32602/i.test(message)) throw error
      const { dynamicTools: _dynamicTools, developerInstructions: _developerInstructions, ...fallback } = params
      result = await this.request('thread/start', fallback) as { thread: CodexThread }
    }
    this.loadedThreads.add(result.thread.id)
    if (title) await this.request('thread/name/set', { threadId: result.thread.id, name: title })
    return { ...threadInfo(result.thread), title: title ?? threadInfo(result.thread).title }
  }

  async sessionDelete(id: string): Promise<void> {
    await this.request('thread/delete', { threadId: id })
    this.loadedThreads.delete(id)
  }

  async sessionRename(id: string, title: string): Promise<SessionInfo> {
    await this.request('thread/name/set', { threadId: id, name: title })
    return { id, title, directory: this.projectPath, time: { updated: Date.now() } }
  }

  async sessionGet(id: string): Promise<SessionInfo> {
    const result = await this.request('thread/read', { threadId: id, includeTurns: false }) as { thread: CodexThread }
    return threadInfo(result.thread)
  }

  private async ensureLoaded(id: string): Promise<void> {
    if (this.loadedThreads.has(id)) return
    try {
      await this.request('thread/resume', { threadId: id, dynamicTools: THREAD_BUS_TOOLS, developerInstructions: QA_GUIDANCE })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!/dynamicTools|developerInstructions|experimental|invalid params|unknown field|-32602/i.test(message)) throw error
      await this.request('thread/resume', { threadId: id })
    }
    this.loadedThreads.add(id)
  }

  async messagesList(sessionId: string, limit?: number): Promise<MessageWithParts[]> {
    const result = await this.request('thread/read', { threadId: sessionId, includeTurns: true }) as { thread: CodexThread }
    const messages = (result.thread.turns ?? []).flatMap((turn) => turnMessages(sessionId, turn))
    return limit ? messages.slice(-limit) : messages
  }

  async sendMessage(sessionId: string, parts: unknown[], options?: BackendMessageOptions): Promise<void> {
    await this.ensureLoaded(sessionId)
    const mode = options?.mode ?? 'ask'
    const params: Record<string, unknown> = {
      threadId: sessionId,
      input: userInputs(parts),
      cwd: this.projectPath || undefined,
      approvalPolicy: mode === 'auto' ? 'never' : 'on-request',
      sandboxPolicy: mode === 'plan'
        ? { type: 'readOnly', networkAccess: false }
        : {
            type: 'workspaceWrite',
            writableRoots: this.projectPath ? [this.projectPath] : [],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false
          }
    }
    if (options?.model?.modelID) params.model = options.model.modelID
    if (options?.model?.variant) params.effort = options.model.variant
    const result = await this.request('turn/start', params) as { turn?: CodexTurn }
    if (result.turn?.id) this.activeTurns.set(sessionId, result.turn.id)
  }

  async steer(sessionId: string, parts: unknown[]): Promise<void> {
    const turnId = this.activeTurns.get(sessionId)
    if (!turnId) throw new Error('Codex no longer has an active turn to steer.')
    await this.request('turn/steer', {
      threadId: sessionId,
      expectedTurnId: turnId,
      input: userInputs(parts)
    })
  }

  async abort(sessionId: string): Promise<void> {
    const turnId = this.activeTurns.get(sessionId)
    if (turnId) await this.request('turn/interrupt', { threadId: sessionId, turnId })
  }

  async modelsList(): Promise<ModelInfo[]> {
    const result = await this.request('model/list', { limit: 100, includeHidden: false }) as {
      data?: Array<{
        id: string
        displayName?: string
        supportedReasoningEfforts?: Array<{ reasoningEffort?: string }>
      }>
    }
    return (result.data ?? []).map((model) => ({
      id: model.id,
      name: model.displayName,
      provider: 'openai',
      variants: model.supportedReasoningEfforts?.map((item) => item.reasoningEffort).filter((item): item is string => Boolean(item)) ?? []
    }))
  }

  async modelSelect(_providerId: string, _modelId: string): Promise<void> {}
  async thinkingGet(): Promise<ThinkingLevel> { return { level: 'medium' } }
  async thinkingSet(_level: ThinkingLevel['level']): Promise<void> {}
  async todosGet(_sessionId: string): Promise<Todo[]> { return [] }

  async permissionRespond(sessionId: string, permissionId: string, response: 'once' | 'always' | 'reject'): Promise<void> {
    const approval = this.approvals.get(permissionId)
    if (!approval) return
    this.approvals.delete(permissionId)
    if (approval.method === 'item/permissions/requestApproval') {
      this.respond(approval.rpcId, {
        permissions: response === 'reject' ? {} : approval.params.permissions ?? {},
        scope: response === 'always' ? 'session' : 'turn'
      })
    } else {
      this.respond(approval.rpcId, { decision: response === 'reject' ? 'decline' : response === 'always' ? 'acceptForSession' : 'accept' })
    }
    this.emit({ type: 'permission.replied', sessionID: sessionId, permissionID: permissionId, response })
  }

  async diffGet(sessionId: string): Promise<FileDiff[]> {
    const result = await this.request('thread/read', { threadId: sessionId, includeTurns: true }) as { thread: CodexThread }
    return (result.thread.turns ?? []).flatMap((turn) => turn.items ?? []).filter((item) => item.type === 'fileChange').flatMap((item) =>
      (item.changes ?? []).map((change) => ({ path: change.path ?? 'unknown', content: change.diff ?? '', status: change.kind ?? 'changed' }))
    )
  }

  async fileTree(_path?: string): Promise<FileNode[]> { return [] }
  async fileContent(path: string): Promise<FileContent> { return { path, content: '' } }

  async fork(sessionId: string): Promise<SessionInfo> {
    const result = await this.request('thread/fork', { threadId: sessionId, cwd: this.projectPath || undefined }) as { thread: CodexThread }
    this.loadedThreads.add(result.thread.id)
    return threadInfo(result.thread)
  }

  async revert(_sessionId: string, _messageId: string): Promise<void> {}
  async unrevert(_sessionId: string): Promise<void> {}
  async compact(sessionId: string): Promise<void> {
    await this.ensureLoaded(sessionId)
    await this.request('thread/compact/start', { threadId: sessionId }, 120_000)
  }
}
