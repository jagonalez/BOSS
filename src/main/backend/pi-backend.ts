import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Backend, McpServerConfig, ModelInfo, ThinkingLevel } from './backend'
import type { BackendMessageOptions } from '@shared/backend'
import type { ThreadBusConnection } from '@shared/thread-bus'
import { THREAD_TOOL_DESCRIPTIONS } from '@shared/thread-bus'
import { qaDescription } from '@shared/qa'
import { QA_GUIDANCE } from '@shared/qa'
import type { EventMessage, SessionInfo, MessageWithParts, Todo, FileDiff, FileNode, FileContent, Part } from '@shared/opencode'

type RpcRequest = { id?: string; type: string; [key: string]: unknown }
type RpcResponse = { id?: string; type: 'response'; command: string; success: boolean; data?: unknown; error?: string }
type Pending = { resolve: (value: RpcResponse) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }

interface PiState {
  sessionId: string
  sessionFile?: string
  sessionName?: string
  isStreaming?: boolean
  model?: { id?: string; name?: string; provider?: string }
  thinkingLevel?: ThinkingLevel['level']
}

interface PiMessage {
  id?: string
  role?: 'user' | 'assistant' | 'toolResult' | 'bashExecution'
  content?: string | Array<Record<string, unknown>>
  timestamp?: number | string
  model?: string
  provider?: string
  toolCallId?: string
  toolName?: string
  isError?: boolean
}

type ModelSource = 'local' | 'cloud' | 'custom'

const LOCAL_PROVIDER_IDS = new Set(['ollama', 'llama.cpp', 'llamacpp', 'lmstudio', 'lm-studio', 'vllm', 'sglang'])

function isLocalEndpoint(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase()
    if (hostname === 'localhost' || hostname === '::1' || hostname.endsWith('.local')) return true
    if (hostname.startsWith('127.') || hostname.startsWith('10.') || hostname.startsWith('192.168.')) return true
    const private172 = /^172\.(\d+)\./.exec(hostname)
    return private172 ? Number(private172[1]) >= 16 && Number(private172[1]) <= 31 : false
  } catch {
    return false
  }
}

function piProviderSources(): Map<string, ModelSource> {
  const sources = new Map<string, ModelSource>()
  for (const provider of LOCAL_PROVIDER_IDS) sources.set(provider, 'local')
  try {
    const config = JSON.parse(readFileSync(join(homedir(), '.pi', 'agent', 'models.json'), 'utf8')) as {
      providers?: Record<string, { baseUrl?: unknown }>
    }
    for (const [provider, value] of Object.entries(config.providers ?? {})) {
      const baseUrl = typeof value.baseUrl === 'string' ? value.baseUrl : ''
      sources.set(provider, baseUrl && isLocalEndpoint(baseUrl) ? 'local' : 'custom')
    }
  } catch {
    /* Pi works without custom models.json configuration. */
  }
  return sources
}

function promptContent(parts: unknown[]): { message: string; images: Array<{ type: 'image'; data: string; mimeType: string }> } {
  const text: string[] = []
  const images: Array<{ type: 'image'; data: string; mimeType: string }> = []
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue
    const item = part as { type?: string; text?: string; filename?: string; mime?: string; url?: string }
    if (item.type === 'text' && item.text) {
      text.push(item.text)
      continue
    }
    if (item.type === 'file' && item.mime?.startsWith('image/') && item.url) {
      const match = /^data:([^;,]+);base64,(.*)$/s.exec(item.url)
      if (match) {
        images.push({ type: 'image', mimeType: match[1] || item.mime, data: match[2] })
        continue
      }
    }
    if (item.type === 'file') text.push(`[Attached file: ${item.filename ?? item.mime ?? 'file'}]`)
  }
  return { message: text.join('\n'), images }
}

function contentParts(sessionId: string, messageId: string, content: PiMessage['content']): Part[] {
  if (typeof content === 'string') {
    return [{ id: `${messageId}-text`, type: 'text', sessionID: sessionId, messageID: messageId, text: content }]
  }
  if (!Array.isArray(content)) return []
  return content.flatMap<Part>((block, index): Part[] => {
    const type = String(block.type ?? '')
    if (type === 'text' || type === 'thinking') {
      return [{
        id: `${messageId}-${type}-${index}`,
        type: type === 'thinking' ? 'reasoning' as const : 'text' as const,
        sessionID: sessionId,
        messageID: messageId,
        text: String(block.text ?? block.thinking ?? '')
      }]
    }
    if (type === 'toolCall' || type === 'tool_use') {
      return [{
        id: String(block.id ?? `${messageId}-tool-${index}`),
        type: 'tool' as const,
        sessionID: sessionId,
        messageID: messageId,
        state: {
          status: 'running' as const,
          tool: String(block.name ?? 'tool'),
          input: block.arguments ?? block.input
        }
      }]
    }
    return []
  })
}

function messageText(content: PiMessage['content']): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block.type === 'text')
    .map((block) => String(block.text ?? ''))
    .join('\n')
}

function toMessage(sessionId: string, value: PiMessage, index: number): MessageWithParts | null {
  if (value.role !== 'user' && value.role !== 'assistant') return null
  const created = typeof value.timestamp === 'number' ? value.timestamp : Date.parse(String(value.timestamp ?? '')) || Date.now()
  const id = value.id ?? `${sessionId}-${created}-${index}`
  return {
    info: {
      id,
      sessionID: sessionId,
      role: value.role,
      model: value.model ? { id: value.model, provider: value.provider } : undefined,
      time: { created }
    },
    parts: contentParts(sessionId, id, value.content)
  }
}

class PiRpcSession {
  private process: ChildProcess | null = null
  private nextId = 1
  private pending = new Map<string, Pending>()
  private buffer = ''

  constructor(
    public sessionId: string,
    private readonly cwd: string,
    private readonly onEvent: (sessionId: string, event: Record<string, unknown>) => void,
    private readonly threadBus?: ThreadBusConnection,
    private readonly extensionPath?: string
  ) {}

  async start(): Promise<void> {
    if (this.process) return
    this.process = spawn('pi', [
      '--mode', 'rpc',
      '--session-id', this.sessionId,
      '--approve',
      ...(this.extensionPath ? ['--extension', this.extensionPath] : [])
    ], {
      cwd: this.cwd || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...(this.threadBus ? {
          BOSS_THREAD_BUS_URL: this.threadBus.url,
          BOSS_THREAD_BUS_TOKEN: this.threadBus.tokenFor('pi', this.sessionId),
          BOSS_NATIVE_THREAD_ID: this.sessionId
        } : {})
      }
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
      this.rejectAll(new Error('Pi RPC process exited.'))
      this.onEvent(this.sessionId, { type: 'server.disconnected' })
    })
    await this.send({ type: 'get_state' })
  }

  stop(): void {
    this.process?.kill()
    this.process = null
    this.rejectAll(new Error('Pi RPC process stopped.'))
  }

  send(request: RpcRequest, timeoutMs = 30_000): Promise<RpcResponse> {
    if (!this.process?.stdin) return Promise.reject(new Error('Pi RPC process is not running.'))
    const id = String(this.nextId++)
    this.process.stdin.write(`${JSON.stringify({ ...request, id })}\n`)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Pi ${request.type} request timed out.`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
    })
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
    let value: Record<string, unknown>
    try {
      value = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    if (value.type === 'response') {
      const response = value as RpcResponse
      const pending = this.pending.get(response.id ?? '')
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(response.id ?? '')
      if (response.success) pending.resolve(response)
      else pending.reject(new Error(response.error ?? `Pi ${response.command} failed.`))
      return
    }
    this.onEvent(this.sessionId, value)
  }
}

export class PiBackend implements Backend {
  readonly id = 'pi' as const
  private projectPath = ''
  private eventCb?: (event: EventMessage) => void
  private sessions = new Map<string, PiRpcSession>()
  private sessionDirectories = new Map<string, string>()
  private messageIds = new Map<string, string>()
  private liveText = new Map<string, string>()
  private forkEntryIds = new Map<string, Map<string, string>>()
  private version = ''
  private healthy = false
  private threadBus?: ThreadBusConnection
  private threadBusExtension = ''

  constructor(cwd?: string) {
    this.projectPath = cwd ?? ''
  }

  async start(): Promise<void> {
    try {
      this.version = execFileSync('pi', ['--version'], { encoding: 'utf8', timeout: 2500 }).trim()
      this.healthy = true
    } catch {
      this.healthy = false
      throw new Error('Pi is not installed or could not be started.')
    }
  }

  async stop(): Promise<void> {
    for (const session of this.sessions.values()) session.stop()
    this.sessions.clear()
    this.healthy = false
  }

  async setProject(path: string): Promise<void> {
    if (path === this.projectPath) return
    for (const session of this.sessions.values()) session.stop()
    this.sessions.clear()
    this.projectPath = path
  }

  setSessionDirectory(id: string, directory: string): void {
    this.sessionDirectories.set(id, directory)
  }

  info() {
    return { id: this.id, engine: 'pi', version: this.version, healthy: this.healthy, projectPath: this.projectPath }
  }

  supportsMcp(): boolean { return false }
  async registerMcpServer(_name: string, _config: McpServerConfig): Promise<boolean> { return false }
  async unregisterMcpServer(_name: string): Promise<void> {}

  configureThreadBus(connection: ThreadBusConnection): void {
    this.threadBus = connection
    const directory = join(app.getPath('userData'), 'pi-boss')
    mkdirSync(directory, { recursive: true })
    this.threadBusExtension = join(directory, 'boss_threads.ts')
    writeFileSync(this.threadBusExtension, this.threadToolSource())
  }

  private threadToolSource(): string {
    return `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

async function call(name, args, signal) {
  const url = process.env.BOSS_THREAD_BUS_URL
  const token = process.env.BOSS_THREAD_BUS_TOKEN
  const nativeThreadId = process.env.BOSS_NATIVE_THREAD_ID
  if (!url || !token || !nativeThreadId) throw new Error("BOSS thread collaboration is unavailable.")
  const response = await fetch(url + "/agent-call", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: JSON.stringify({ backendId: "pi", nativeThreadId, tool: name, arguments: args }),
    signal
  })
  const payload = await response.json()
  if (!response.ok || !payload.ok) throw new Error(payload.error || "BOSS thread tool failed.")
  const result = payload.result
  if (result && result.__bossToolResult) {
    return {
      content: [
        { type: "text", text: result.text },
        ...(result.image ? [{ type: "image", data: result.image.data, mimeType: result.image.mimeType }] : [])
      ],
      details: result
    }
  }
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "boss_browser_tabs",
    label: "List BOSS browser tabs",
    description: ${JSON.stringify(qaDescription("boss_browser_tabs"))},
    parameters: Type.Object({}),
    promptSnippet: "Inspect BOSS browser tabs",
    promptGuidelines: [${JSON.stringify(QA_GUIDANCE)}],
    execute: (_id, args, signal) => call("boss_browser_tabs", args, signal)
  })
  pi.registerTool({
    name: "boss_browser_navigate",
    label: "Navigate BOSS browser",
    description: ${JSON.stringify(qaDescription("boss_browser_navigate"))},
    parameters: Type.Object({ tabId: Type.String(), url: Type.String() }),
    execute: (_id, args, signal) => call("boss_browser_navigate", args, signal)
  })
  pi.registerTool({
    name: "boss_browser_snapshot",
    label: "Inspect BOSS browser",
    description: ${JSON.stringify(qaDescription("boss_browser_snapshot"))},
    parameters: Type.Object({ tabId: Type.String() }),
    execute: (_id, args, signal) => call("boss_browser_snapshot", args, signal)
  })
  pi.registerTool({
    name: "boss_browser_screenshot",
    label: "Screenshot BOSS browser",
    description: ${JSON.stringify(qaDescription("boss_browser_screenshot"))},
    parameters: Type.Object({ tabId: Type.String() }),
    execute: (_id, args, signal) => call("boss_browser_screenshot", args, signal)
  })
  pi.registerTool({
    name: "boss_browser_click",
    label: "Click BOSS browser",
    description: ${JSON.stringify(qaDescription("boss_browser_click"))},
    parameters: Type.Object({ tabId: Type.String(), ref: Type.String() }),
    execute: (_id, args, signal) => call("boss_browser_click", args, signal)
  })
  pi.registerTool({
    name: "boss_browser_type",
    label: "Type in BOSS browser",
    description: ${JSON.stringify(qaDescription("boss_browser_type"))},
    parameters: Type.Object({
      tabId: Type.String(),
      ref: Type.String(),
      text: Type.String(),
      submit: Type.Optional(Type.Boolean({ default: false }))
    }),
    execute: (_id, args, signal) => call("boss_browser_type", args, signal)
  })
  pi.registerTool({
    name: "boss_computer",
    label: "BOSS Computer Use",
    description: ${JSON.stringify(qaDescription("boss_computer"))},
    parameters: Type.Object({
      operation: Type.Union([
        Type.Literal("list_apps"), Type.Literal("list_windows"), Type.Literal("get_window_state"),
        Type.Literal("get_desktop_state"), Type.Literal("screenshot"), Type.Literal("zoom"),
        Type.Literal("click"), Type.Literal("type_text"), Type.Literal("press_key"),
        Type.Literal("hotkey"), Type.Literal("scroll"), Type.Literal("wait")
      ]),
      arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown()))
    }),
    execute: (_id, args, signal) => call("boss_computer", args, signal)
  })
  pi.registerTool({
    name: "boss_threads_list",
    label: "List BOSS threads",
    description: ${JSON.stringify(THREAD_TOOL_DESCRIPTIONS.list)},
    parameters: Type.Object({}),
    execute: (_id, args, signal) => call("boss_threads_list", args, signal)
  })
  pi.registerTool({
    name: "boss_threads_read",
    label: "Read BOSS thread",
    description: ${JSON.stringify(THREAD_TOOL_DESCRIPTIONS.read)},
    parameters: Type.Object({
      threadId: Type.String({ description: "BOSS thread id returned by boss_threads_list." }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 8 }))
    }),
    execute: (_id, args, signal) => call("boss_threads_read", args, signal)
  })
  pi.registerTool({
    name: "boss_threads_send",
    label: "Send BOSS thread message",
    description: ${JSON.stringify(THREAD_TOOL_DESCRIPTIONS.send)},
    parameters: Type.Object({
      threadId: Type.String({ description: "BOSS thread id returned by boss_threads_list." }),
      message: Type.String({ description: "Message to send to the other agent." }),
      expectsReply: Type.Optional(Type.Boolean({ default: true })),
      maxTurns: Type.Optional(Type.Integer({ minimum: 1, maximum: 8, default: 4 }))
    }),
    execute: (_id, args, signal) => call("boss_threads_send", args, signal)
  })
  pi.registerTool({
    name: "boss_threads_reply",
    label: "Reply to BOSS thread message",
    description: ${JSON.stringify(THREAD_TOOL_DESCRIPTIONS.reply)},
    parameters: Type.Object({
      messageId: Type.String({ description: "Message id from the incoming BOSS thread message." }),
      message: Type.String({ description: "Reply to send to the other agent." }),
      expectsReply: Type.Optional(Type.Boolean({ default: false }))
    }),
    execute: (_id, args, signal) => call("boss_threads_reply", args, signal)
  })
  pi.registerTool({
    name: "boss_threads_spawn_worktree",
    label: "Spawn BOSS worktree thread",
    description: ${JSON.stringify(THREAD_TOOL_DESCRIPTIONS.spawnWorktree)},
    parameters: Type.Object({
      instruction: Type.String({ description: ${JSON.stringify(THREAD_TOOL_DESCRIPTIONS.spawnWorktreeInstruction)} })
    }),
    execute: (_id, args, signal) => call("boss_threads_spawn_worktree", args, signal)
  })
  pi.registerTool({
    name: "boss_threads_use_worktree",
    label: "Use a BOSS worktree",
    description: ${JSON.stringify(THREAD_TOOL_DESCRIPTIONS.useWorktree)},
    parameters: Type.Object({}),
    execute: (_id, args, signal) => call("boss_threads_use_worktree", args, signal)
  })
  pi.registerTool({
    name: "boss_threads_leave_worktree",
    label: "Leave the BOSS worktree",
    description: ${JSON.stringify(THREAD_TOOL_DESCRIPTIONS.leaveWorktree)},
    parameters: Type.Object({}),
    execute: (_id, args, signal) => call("boss_threads_leave_worktree", args, signal)
  })
  pi.registerTool({
    name: "boss_mcp_list",
    label: "List BOSS MCP tools",
    description: "List external MCP tools available through BOSS connections. Pass tool to get one tool's full input schema before calling it.",
    parameters: Type.Object({ tool: Type.Optional(Type.String({ description: "Tool name from the catalog; returns its full input schema." })) }),
    execute: (_id, args, signal) => call("boss_mcp_list", args, signal)
  })
  pi.registerTool({
    name: "boss_mcp_call",
    label: "Call BOSS MCP tool",
    description: "Call an external MCP tool listed by boss_mcp_list.",
    parameters: Type.Object({
      tool: Type.String({ description: "Tool name from boss_mcp_list." }),
      arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown()))
    }),
    execute: (_id, args, signal) => call("boss_mcp_call", args, signal)
  })
}
`
  }

  onEvent(callback: (event: EventMessage) => void): () => void {
    this.eventCb = callback
    return () => { if (this.eventCb === callback) this.eventCb = undefined }
  }

  private emit(event: EventMessage): void {
    this.eventCb?.(event)
  }

  private async runtime(sessionId: string): Promise<PiRpcSession> {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing
    const runtime = new PiRpcSession(
      sessionId,
      this.sessionDirectories.get(sessionId) || this.projectPath,
      (activeSessionId, event) => this.mapEvent(activeSessionId, event),
      this.threadBus,
      this.threadBusExtension || undefined
    )
    this.sessions.set(sessionId, runtime)
    try {
      await runtime.start()
      return runtime
    } catch (error) {
      this.sessions.delete(sessionId)
      throw error
    }
  }

  private mapEvent(sessionId: string, event: Record<string, unknown>): void {
    switch (event.type) {
      case 'agent_start':
        this.emit({ type: 'session.status', sessionID: sessionId, status: { type: 'busy' } })
        break
      case 'agent_end':
      case 'agent_settled':
        this.emit({ type: 'session.status', sessionID: sessionId, status: { type: 'idle' } })
        this.emit({ type: 'session.idle', sessionID: sessionId })
        break
      case 'message_start': {
        const message = event.message as PiMessage | undefined
        if (!message || message.role !== 'assistant') break
        const id = message.id ?? randomUUID()
        this.messageIds.set(sessionId, id)
        this.liveText.set(sessionId, '')
        this.emit({ type: 'message.updated', message: { id, sessionID: sessionId, role: 'assistant', time: { created: Date.now() } } })
        break
      }
      case 'message_update': {
        const delta = event.assistantMessageEvent as { type?: string; delta?: string; content?: string } | undefined
        if (!delta || delta.type !== 'text_delta') break
        const messageID = this.messageIds.get(sessionId) ?? randomUUID()
        const text = `${this.liveText.get(sessionId) ?? ''}${delta.delta ?? ''}`
        this.messageIds.set(sessionId, messageID)
        this.liveText.set(sessionId, text)
        this.emit({
          type: 'message.part.updated',
          part: { id: `${messageID}-text`, type: 'text', sessionID: sessionId, messageID, text }
        })
        break
      }
      case 'message_end': {
        const message = event.message as PiMessage | undefined
        if (!message) break
        const converted = toMessage(
          sessionId,
          message.role === 'assistant' ? { ...message, id: message.id ?? this.messageIds.get(sessionId) } : message,
          0
        )
        if (!converted) break
        this.emit({ type: 'message.updated', message: converted.info })
        converted.parts.forEach((part) => this.emit({ type: 'message.part.updated', part }))
        break
      }
      case 'tool_execution_start': {
        const messageID = this.messageIds.get(sessionId) ?? randomUUID()
        this.emit({
          type: 'message.part.updated',
          part: {
            id: String(event.toolCallId ?? randomUUID()),
            type: 'tool',
            sessionID: sessionId,
            messageID,
            state: { status: 'running', tool: String(event.toolName ?? 'tool'), input: event.args }
          }
        })
        break
      }
      case 'tool_execution_end': {
        const messageID = this.messageIds.get(sessionId) ?? randomUUID()
        this.emit({
          type: 'message.part.updated',
          part: {
            id: String(event.toolCallId ?? randomUUID()),
            type: 'tool',
            sessionID: sessionId,
            messageID,
            state: {
              status: event.isError ? 'error' : 'completed',
              tool: String(event.toolName ?? 'tool'),
              output: event.result
            }
          }
        })
        break
      }
      case 'tool_execution_update': {
        const messageID = this.messageIds.get(sessionId) ?? randomUUID()
        this.emit({
          type: 'message.part.updated',
          part: {
            id: String(event.toolCallId ?? randomUUID()),
            type: 'tool',
            sessionID: sessionId,
            messageID,
            state: {
              status: 'running',
              tool: String(event.toolName ?? 'tool'),
              input: event.args,
              output: event.partialResult
            }
          }
        })
        break
      }
      case 'compaction_start':
        this.emit({ type: 'session.status', sessionID: sessionId, status: { type: 'busy' } })
        break
      case 'compaction_end':
        this.emit({ type: 'session.compacted', sessionID: sessionId })
        break
      case 'extension_error':
        this.emit({ type: 'session.error', sessionID: sessionId, error: String(event.error ?? 'Pi extension error') })
        break
    }
  }

  async sessionsList(): Promise<SessionInfo[]> {
    return Promise.all([...this.sessions.keys()].map((id) => this.sessionGet(id)))
  }

  async sessionCreate(title?: string, directory?: string): Promise<SessionInfo> {
    const id = randomUUID()
    const sessionDirectory = directory || this.projectPath
    this.sessionDirectories.set(id, sessionDirectory)
    const runtime = await this.runtime(id)
    if (title) await runtime.send({ type: 'set_session_name', name: title })
    return { id, title, directory: sessionDirectory, time: { created: Date.now(), updated: Date.now() } }
  }

  async sessionDelete(id: string): Promise<void> {
    const runtime = await this.runtime(id)
    const state = (await runtime.send({ type: 'get_state' })).data as PiState | undefined
    runtime.stop()
    this.sessions.delete(id)
    this.sessionDirectories.delete(id)
    if (state?.sessionFile) {
      try { unlinkSync(state.sessionFile) } catch { /* already gone or managed externally */ }
    }
  }

  async sessionRename(id: string, title: string): Promise<SessionInfo> {
    await (await this.runtime(id)).send({ type: 'set_session_name', name: title })
    return { id, title, directory: this.projectPath, time: { updated: Date.now() } }
  }

  async sessionGet(id: string): Promise<SessionInfo> {
    const state = (await (await this.runtime(id)).send({ type: 'get_state' })).data as PiState | undefined
    return {
      id,
      title: state?.sessionName,
      directory: this.sessionDirectories.get(id) || this.projectPath,
      path: state?.sessionFile,
      model: state?.model?.id ? { id: state.model.id, provider: state.model.provider } : undefined,
      time: { updated: Date.now() }
    }
  }

  async messagesList(sessionId: string, limit?: number): Promise<MessageWithParts[]> {
    const runtime = await this.runtime(sessionId)
    const response = await runtime.send({ type: 'get_messages' })
    const data = response.data as { messages?: PiMessage[] } | undefined
    const forkResponse = await runtime.send({ type: 'get_fork_messages' }).catch(() => undefined)
    const forkData = forkResponse?.data as { messages?: Array<{ entryId?: string; text?: string }> } | undefined
    const availableForks = [...(forkData?.messages ?? [])]
    const mappedEntries = new Map<string, string>()
    const messages: MessageWithParts[] = []
    for (const [index, message] of (data?.messages ?? []).entries()) {
      if (message.role === 'toolResult' && message.toolCallId) {
        for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
          const partIndex = messages[messageIndex].parts.findIndex((part) => part.id === message.toolCallId)
          if (partIndex < 0) continue
          const part = messages[messageIndex].parts[partIndex]
          messages[messageIndex].parts[partIndex] = {
            ...part,
            state: {
              ...part.state,
              status: message.isError ? 'error' : 'completed',
              tool: message.toolName ?? part.state?.tool,
              output: message.content
            }
          }
          break
        }
        continue
      }
      const converted = toMessage(sessionId, message, index)
      if (converted) {
        messages.push(converted)
        if (message.role === 'user') {
          const text = messageText(message.content)
          const matchIndex = availableForks.findIndex((candidate) => candidate.text === text)
          if (matchIndex >= 0) {
            const [match] = availableForks.splice(matchIndex, 1)
            if (match.entryId) mappedEntries.set(converted.info.id, match.entryId)
          }
        }
      }
    }
    this.forkEntryIds.set(sessionId, mappedEntries)
    return limit ? messages.slice(-limit) : messages
  }

  async sendMessage(sessionId: string, parts: unknown[], options?: BackendMessageOptions): Promise<void> {
    const runtime = await this.runtime(sessionId)
    if (options?.model) {
      await runtime.send({ type: 'set_model', provider: options.model.providerID, modelId: options.model.modelID })
      if (options.model.variant) await runtime.send({ type: 'set_thinking_level', level: options.model.variant })
    }
    const content = promptContent(parts)
    await runtime.send({ type: 'prompt', message: content.message, ...(content.images.length ? { images: content.images } : {}) })
  }

  async steer(sessionId: string, parts: unknown[]): Promise<void> {
    const content = promptContent(parts)
    await (await this.runtime(sessionId)).send({
      type: 'steer',
      message: content.message,
      ...(content.images.length ? { images: content.images } : {})
    })
  }

  async abort(sessionId: string): Promise<void> { await (await this.runtime(sessionId)).send({ type: 'abort' }) }

  async modelsList(): Promise<ModelInfo[]> {
    const providerSources = piProviderSources()
    const runtime = this.sessions.values().next().value as PiRpcSession | undefined
    if (!runtime) {
      try {
        const output = execFileSync('pi', ['--offline', '--list-models'], { encoding: 'utf8', timeout: 12_000 })
        return output.split(/\r?\n/).slice(1).flatMap((line) => {
          const fields = line.trim().split(/\s{2,}/)
          if (fields.length < 6) return []
          const [provider, id, , , thinking] = fields
          return [{
            id,
            name: id,
            provider,
            variants: thinking === 'yes' ? ['off', 'minimal', 'low', 'medium', 'high'] : [],
            source: providerSources.get(provider) ?? 'cloud'
          }]
        })
      } catch {
        return []
      }
    }
    const response = await runtime.send({ type: 'get_available_models' })
    const data = response.data as {
      models?: Array<{ id: string; name?: string; provider?: string; reasoning?: boolean; thinkingLevelMap?: Record<string, unknown> }>
    } | Array<{ id: string; name?: string; provider?: string; reasoning?: boolean; thinkingLevelMap?: Record<string, unknown> }> | undefined
    const models = Array.isArray(data) ? data : data?.models ?? []
    return models.map((model) => {
      const explicit = Object.keys(model.thinkingLevelMap ?? {})
      return {
        id: model.id,
        name: model.name,
        provider: model.provider,
        variants: explicit.length > 0 ? explicit : model.reasoning ? ['off', 'minimal', 'low', 'medium', 'high'] : [],
        source: model.provider ? providerSources.get(model.provider) ?? 'cloud' : undefined
      }
    })
  }

  async modelSelect(_providerId: string, _modelId: string): Promise<void> {}
  async thinkingGet(): Promise<ThinkingLevel> { return { level: 'medium' } }
  async thinkingSet(_level: ThinkingLevel['level']): Promise<void> {}
  async todosGet(_sessionId: string): Promise<Todo[]> { return [] }
  async permissionRespond(_sessionId: string, _permissionId: string, _response: 'once' | 'always' | 'reject'): Promise<void> {}
  async diffGet(_sessionId: string, _messageId?: string): Promise<FileDiff[]> { return [] }
  async fileTree(_path?: string): Promise<FileNode[]> { return [] }
  async fileContent(path: string): Promise<FileContent> { return { path, content: '' } }

  async fork(sessionId: string, messageId?: string): Promise<SessionInfo> {
    const runtime = await this.runtime(sessionId)
    let entryId: string | undefined
    if (messageId) {
      entryId = this.forkEntryIds.get(sessionId)?.get(messageId)
      if (!entryId) {
        await this.messagesList(sessionId)
        entryId = this.forkEntryIds.get(sessionId)?.get(messageId)
      }
      if (!entryId) throw new Error('Pi could not match this message to a branch point. Refresh the thread and try again.')
    }
    await runtime.send(entryId ? { type: 'fork', entryId } : { type: 'clone' })
    const state = (await runtime.send({ type: 'get_state' })).data as PiState | undefined
    const newId = state?.sessionId
    if (!newId || newId === sessionId) return { id: sessionId }
    const directory = this.sessionDirectories.get(sessionId) || this.projectPath
    this.sessions.delete(sessionId)
    this.sessionDirectories.delete(sessionId)
    runtime.sessionId = newId
    this.sessions.set(newId, runtime)
    this.sessionDirectories.set(newId, directory)
    return { id: newId, title: state.sessionName, directory, path: state.sessionFile }
  }

  async revert(_sessionId: string, _messageId: string): Promise<void> {}
  async unrevert(_sessionId: string): Promise<void> {}
  async compact(sessionId: string): Promise<void> { await (await this.runtime(sessionId)).send({ type: 'compact' }, 120_000) }
}
