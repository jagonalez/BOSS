import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { resolveBackendBin } from '../backend-bin'
import { randomUUID } from 'node:crypto'
import type { Backend, McpServerConfig, ModelInfo, ThinkingLevel, ThreadTitleGenerationOptions } from './backend'
import { BACKEND_IDS, type BackendMessageOptions, type BackendModeId } from '@shared/backend'
import type { ThreadBusAgentTool, ThreadBusToolCall } from '@shared/thread-bus'
import { REPORT_TOOL_DESCRIPTIONS, THREAD_TOOL_DESCRIPTIONS, WORKFLOW_TOOL_DESCRIPTIONS } from '@shared/thread-bus'
import { QA_GUIDANCE, QA_TOOL_DEFINITIONS, isAgentToolResult } from '@shared/qa'
import type { EventMessage, SessionInfo, MessageWithParts, Todo, FileDiff, FileNode, FileContent, Part } from '@shared/opencode'
import { SessionDirectories } from './session-directory'
import { DEFAULT_SANDBOX_SETTINGS, type SandboxSettings } from '@shared/sandbox'
import { toolLabel } from '@shared/tool-label'
import { compactionCompletedEvents } from './compaction-events'
import { splitCodexTurnItems } from './codex-turn-order'
import { codexToolOutput } from './codex-tool-output'

type RpcId = string | number
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
type TitleRun = { text: string; resolve: (value: string | undefined) => void; timer: NodeJS.Timeout }

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
  content?: Array<{
    type?: string
    text?: string
    url?: string
    imageUrl?: string
    image_url?: string
    path?: string
  }>
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
    name: 'boss_threads_list',
    description: THREAD_TOOL_DESCRIPTIONS.list,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    type: 'function',
    name: 'boss_threads_read',
    description: THREAD_TOOL_DESCRIPTIONS.read,
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string', description: 'BOSS thread id returned by boss_threads_list.' },
        limit: { type: 'number', description: 'Number of recent messages to read, from 1 to 20.' }
      },
      required: ['threadId'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'boss_threads_send',
    description: THREAD_TOOL_DESCRIPTIONS.send,
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string', description: 'Target BOSS thread id.' },
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
    name: 'boss_threads_reply',
    description: THREAD_TOOL_DESCRIPTIONS.reply,
    inputSchema: {
      type: 'object',
      properties: {
        messageId: { type: 'string', description: 'Message id included in the incoming BOSS message.' },
        message: { type: 'string', description: 'Reply for the sending thread.' },
        expectsReply: { type: 'boolean', description: 'Whether another response is useful.' }
      },
      required: ['messageId', 'message'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'boss_threads_spawn_worktree',
    description: THREAD_TOOL_DESCRIPTIONS.spawnWorktree,
    inputSchema: {
      type: 'object',
      properties: {
        instruction: { type: 'string', description: THREAD_TOOL_DESCRIPTIONS.spawnWorktreeInstruction },
        project: { type: 'string', description: THREAD_TOOL_DESCRIPTIONS.spawnWorktreeProject },
        agent: {
          type: 'string',
          enum: [...BACKEND_IDS],
          description: THREAD_TOOL_DESCRIPTIONS.spawnWorktreeAgent
        }
      },
      required: ['instruction'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'boss_threads_use_worktree',
    description: THREAD_TOOL_DESCRIPTIONS.useWorktree,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    type: 'function',
    name: 'boss_threads_leave_worktree',
    description: THREAD_TOOL_DESCRIPTIONS.leaveWorktree,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    type: 'function',
    name: 'boss_git_create_change_request',
    description: THREAD_TOOL_DESCRIPTIONS.createChangeRequest,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: THREAD_TOOL_DESCRIPTIONS.createChangeRequestTitle },
        body: { type: 'string', description: THREAD_TOOL_DESCRIPTIONS.createChangeRequestBody },
        baseBranch: { type: 'string', description: THREAD_TOOL_DESCRIPTIONS.createChangeRequestBase },
        draft: { type: 'boolean', description: THREAD_TOOL_DESCRIPTIONS.createChangeRequestDraft }
      },
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'boss_reports_create',
    description: REPORT_TOOL_DESCRIPTIONS.create,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: REPORT_TOOL_DESCRIPTIONS.title },
        summary: { type: 'string', description: REPORT_TOOL_DESCRIPTIONS.summary },
        body: { type: 'string', description: REPORT_TOOL_DESCRIPTIONS.body }
      },
      required: ['title', 'body'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'boss_reports_update',
    description: REPORT_TOOL_DESCRIPTIONS.update,
    inputSchema: {
      type: 'object',
      properties: {
        reportId: { type: 'string', description: REPORT_TOOL_DESCRIPTIONS.reportId },
        title: { type: 'string', description: REPORT_TOOL_DESCRIPTIONS.title },
        summary: { type: 'string', description: REPORT_TOOL_DESCRIPTIONS.summary },
        body: { type: 'string', description: REPORT_TOOL_DESCRIPTIONS.body }
      },
      required: ['reportId'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'boss_workflow_list',
    description: WORKFLOW_TOOL_DESCRIPTIONS.list,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    type: 'function',
    name: 'boss_workflow_create',
    description: WORKFLOW_TOOL_DESCRIPTIONS.create,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: WORKFLOW_TOOL_DESCRIPTIONS.name },
        description: { type: 'string', description: WORKFLOW_TOOL_DESCRIPTIONS.description },
        script: { type: 'string', description: WORKFLOW_TOOL_DESCRIPTIONS.script },
        cron: { type: 'string', description: WORKFLOW_TOOL_DESCRIPTIONS.cron },
        eventType: { type: 'string', description: WORKFLOW_TOOL_DESCRIPTIONS.eventType },
        eventFilters: { type: 'object', description: WORKFLOW_TOOL_DESCRIPTIONS.eventFilters }
      },
      required: ['name', 'script'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'boss_workflow_update',
    description: WORKFLOW_TOOL_DESCRIPTIONS.update,
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: WORKFLOW_TOOL_DESCRIPTIONS.workflowId },
        name: { type: 'string', description: WORKFLOW_TOOL_DESCRIPTIONS.name },
        description: { type: 'string', description: WORKFLOW_TOOL_DESCRIPTIONS.description },
        script: { type: 'string', description: WORKFLOW_TOOL_DESCRIPTIONS.script },
        cron: { type: 'string', description: WORKFLOW_TOOL_DESCRIPTIONS.cron },
        eventType: { type: 'string', description: WORKFLOW_TOOL_DESCRIPTIONS.eventType },
        eventFilters: { type: 'object', description: WORKFLOW_TOOL_DESCRIPTIONS.eventFilters }
      },
      required: ['workflowId'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'boss_workflow_run',
    description: WORKFLOW_TOOL_DESCRIPTIONS.run,
    inputSchema: {
      type: 'object',
      properties: { workflowId: { type: 'string', description: WORKFLOW_TOOL_DESCRIPTIONS.workflowId } },
      required: ['workflowId'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'boss_workflow_runs',
    description: WORKFLOW_TOOL_DESCRIPTIONS.runs,
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: WORKFLOW_TOOL_DESCRIPTIONS.workflowId },
        limit: { type: 'integer', minimum: 1, maximum: 20, default: 5, description: WORKFLOW_TOOL_DESCRIPTIONS.limit }
      },
      additionalProperties: false
    }
  },
  ...QA_TOOL_DEFINITIONS.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema
  })),
  {
    type: 'function',
    name: 'boss_mcp_list',
    description: 'List external MCP tools available through BOSS connections (Slack, Datadog, and other services). Pass tool to get one tool\'s full input schema before calling it.',
    inputSchema: {
      type: 'object',
      properties: { tool: { type: 'string', description: 'Optional: tool name from the catalog; returns its full input schema.' } },
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'boss_mcp_call',
    description: 'Call an external MCP tool listed by boss_mcp_list.',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'Tool name from boss_mcp_list.' },
        arguments: { type: 'object', description: 'Arguments for the tool.', additionalProperties: true }
      },
      required: ['tool'],
      additionalProperties: false
    }
  }
]

// Dispatch exactly what this backend advertised. A separate hand-maintained
// prefix allowlist rejected boss_git_create_change_request at runtime even
// though it appeared in the model's tool schema.
const THREAD_BUS_TOOL_NAMES = new Set(THREAD_BUS_TOOLS.map((tool) => String(tool.name ?? '')))

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

function userParts(sessionId: string, messageId: string, content?: CodexItem['content']): Part[] {
  const text = (content ?? [])
    .filter((item) => item.type === 'text' || item.type === 'inputText' || item.type === 'input_text')
    .map((item) => item.text ?? '')
    .filter(Boolean)
    .join('\n')
  const parts: Part[] = text
    ? [{ id: `${messageId}-text`, type: 'text', sessionID: sessionId, messageID: messageId, text }]
    : []
  for (const [index, item] of (content ?? []).entries()) {
    if (item.type !== 'image' && item.type !== 'inputImage' && item.type !== 'input_image') continue
    const url = item.url ?? item.imageUrl ?? item.image_url
    if (!url) continue
    const mime = /^data:([^;,]+)/.exec(url)?.[1] ?? 'image/png'
    parts.push({
      id: `${messageId}-image-${index}`,
      type: 'file',
      sessionID: sessionId,
      messageID: messageId,
      state: {
        status: 'completed',
        path: item.path ?? `image-${index + 1}`,
        name: item.path ?? `image-${index + 1}`,
        mime,
        url
      }
    })
  }
  return parts
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
  return codexToolOutput(item.contentItems)
}

function itemPart(sessionId: string, messageId: string, item: CodexItem): Part | null {
  if (item.type === 'agentMessage' || item.type === 'plan') {
    return { id: item.id, type: 'text', sessionID: sessionId, messageID: messageId, text: item.text ?? '' }
  }
  if (item.type === 'reasoning') {
    // Blank line between summaries: single newlines collapse to spaces in markdown.
    return { id: item.id, type: 'reasoning', sessionID: sessionId, messageID: messageId, text: (item.summary ?? []).join('\n\n') }
  }
  // Codex wraps BOSS-provided tools (boss_mcp_call, thread tools) in its
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
        // The name alone repeats down the transcript; the argument is what tells two calls apart.
        title: toolLabel(String(item.name ?? ''), item.input) ?? item.name,
        input: item.input
      }
    }
  }
  if (item.type === 'customToolCallOutput' || item.type === 'custom_tool_call_output') {
    return {
      id: item.call_id ?? item.callId ?? item.id,
      type: 'tool',
      sessionID: sessionId,
      messageID: messageId,
      state: { status: 'completed', output: codexToolOutput(item.output) }
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

/** A user message id both the live stream and a reload can compute.
 *
 *  Codex identifies the same user message two different ways: `item/completed`
 *  carries a freshly minted uuid, while `thread/read` renumbers the turn's
 *  items as `item-1`, `item-2`, … So the id BOSS stored while the run streamed
 *  never appeared in the reload, and reconcile — which deletes anything native
 *  history does not report — dropped every user message in the thread. The
 *  turn id is the one identifier both paths agree on (live `turnId` equals the
 *  history `turn.id`), and Codex reports a turn's user items in the order they
 *  were said, so turn + ordinal is stable across both. */
function codexUserMessageId(turnId: string, index: number): string {
  return `user-${turnId}-${index}`
}

function codexAssistantMessageId(turnId: string, index: number): string {
  if (index < 0) return `assistant-${turnId}-prelude`
  return index === 0 ? `assistant-${turnId}` : `assistant-${turnId}-${index}`
}

function turnMessages(sessionId: string, turn: CodexTurn): MessageWithParts[] {
  return splitCodexTurnItems(turn.items ?? []).map((slice): MessageWithParts => {
    if (slice.role === 'user') {
      const id = codexUserMessageId(turn.id, slice.index)
      return {
        info: { id, sessionID: sessionId, role: 'user', time: { created: turn.startedAt ? turn.startedAt * 1000 : undefined } },
        parts: userParts(sessionId, id, slice.item.content)
      }
    }
    const id = codexAssistantMessageId(turn.id, slice.index)
    return {
      info: {
        id,
        sessionID: sessionId,
        role: 'assistant',
        time: {
          created: turn.startedAt ? turn.startedAt * 1000 : undefined,
          completed: turn.completedAt ? turn.completedAt * 1000 : undefined
        }
      },
      parts: slice.items.map((item) => itemPart(sessionId, id, item)).filter(Boolean) as Part[]
    }
  })
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
  /** turnId -> the turn's user item ids, in arrival order. Gives a streaming
   *  user message the same ordinal the reload will derive from turn.items, and
   *  keys off the item id so item/started and item/completed — which both fire
   *  for one item — agree rather than counting it twice. */
  private turnUserItems = new Map<string, string[]>()
  /** The user segment new assistant items belong to while a turn streams. */
  private turnAssistantSegments = new Map<string, number>()
  /** An item keeps the segment where it started even if steering happens
   *  before its completion notification arrives. */
  private turnAssistantItems = new Map<string, Map<string, number>>()
  private titleRuns = new Map<string, TitleRun>()
  private manualCompactions = new Set<string>()
  private eventCb?: (event: EventMessage) => void
  private projectPath = ''
  private readonly sessionDirectories = new SessionDirectories()
  private readonly sessionWritableRoots = new Map<string, string[]>()
  private version = ''
  private healthy = false
  private buffer = ''
  private threadBusHandler?: (call: ThreadBusToolCall) => Promise<unknown>
  private sandboxSettings: SandboxSettings = { ...DEFAULT_SANDBOX_SETTINGS }

  constructor(cwd?: string) {
    this.projectPath = cwd ?? ''
  }

  async start(): Promise<void> {
    if (this.process) return
    const bin = resolveBackendBin('codex')
    try {
      this.version = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 2500 }).trim()
    } catch {
      throw new Error('Codex CLI is not installed or could not be started.')
    }
    this.process = spawn(bin, ['app-server', '--stdio'], {
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
      this.forgetServerState()
      this.rejectAll(new Error('Codex app-server exited.'))
      this.emit({ type: 'server.disconnected' })
    })
    await this.request('initialize', {
      clientInfo: { name: 'boss_desktop', title: 'BOSS', version: '0.1.0' },
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
    this.forgetServerState()
    this.rejectAll(new Error('Codex app-server stopped.'))
  }

  /** Drop what BOSS believed about a server that is no longer running.
   *
   *  These record the server's state, not BOSS's: which threads it has resumed,
   *  which turns it is running, and the text those turns had streamed so far. A
   *  new app-server knows none of it. Keeping the old answers made BOSS skip the
   *  resume for a thread it thought was already loaded, and the fresh server
   *  then rejected the id — "thread not found" for a thread still on disk. */
  private forgetServerState(): void {
    this.loadedThreads.clear()
    this.activeTurns.clear()
    this.liveText.clear()
    this.turnUserItems.clear()
    this.turnAssistantSegments.clear()
    this.turnAssistantItems.clear()
    this.approvals.clear()
    for (const [threadId] of this.titleRuns) this.finishTitleRun(threadId)
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
      if (!this.threadBusHandler || !THREAD_BUS_TOOL_NAMES.has(tool)) {
        this.respond(id, { contentItems: [{ type: 'inputText', text: 'Unknown BOSS tool.' }], success: false })
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
    // BOSS cannot safely render these request types yet. Resolve them conservatively.
    if (method === 'item/tool/requestUserInput' || method === 'mcpServer/elicitation/request') {
      this.respond(id, { action: 'cancel', content: null })
    } else {
      this.respond(id, { decision: 'decline' })
    }
  }

  /** The position of this user item within its turn, counting from zero. */
  private userMessageOrdinal(sessionId: string, turnId: string, itemId: string): number {
    const key = `${sessionId}:${turnId}`
    const seen = this.turnUserItems.get(key) ?? []
    const existing = seen.indexOf(itemId)
    if (existing >= 0) return existing
    seen.push(itemId)
    this.turnUserItems.set(key, seen)
    return seen.length - 1
  }

  private assistantMessageId(sessionId: string, turnId: string, itemId: string): string {
    const key = `${sessionId}:${turnId}`
    const items = this.turnAssistantItems.get(key) ?? new Map<string, number>()
    let segment = items.get(itemId)
    if (segment === undefined) {
      segment = this.turnAssistantSegments.get(key) ?? 0
      items.set(itemId, segment)
      this.turnAssistantItems.set(key, items)
    }
    return codexAssistantMessageId(turnId, segment)
  }

  /** Publish input as soon as Codex accepts the turn.
   *
   * Codex does not consistently report its userMessage item until the turn is
   * complete. Waiting for that notification leaves the composer empty for the
   * whole reasoning run, and a long turn makes a successful send look lost.
   * turn/start already gives us the durable turn id, so this message uses the
   * same id that the later live event and history reload derive. Those paths
   * therefore update this row instead of drawing a duplicate. */
  private emitUserMessage(
    sessionId: string,
    turnId: string,
    index: number,
    content: CodexItem['content'],
    createdAt = Date.now()
  ): void {
    const messageId = codexUserMessageId(turnId, index)
    this.emit({
      type: 'message.updated',
      message: { id: messageId, sessionID: sessionId, role: 'user', time: { created: createdAt } }
    })
    for (const part of userParts(sessionId, messageId, content)) {
      this.emit({ type: 'message.part.updated', part })
    }
  }

  private mapNotification(method: string, params: Record<string, unknown>): void {
    const sessionId = String(params.threadId ?? '')
    const titleRun = this.titleRuns.get(sessionId)
    if (titleRun) {
      if (method === 'item/agentMessage/delta') {
        titleRun.text += String(params.delta ?? '')
      } else if (method === 'item/completed') {
        const item = params.item as CodexItem | undefined
        if (item?.type === 'agentMessage' && item.text) titleRun.text = item.text
      } else if (method === 'turn/completed') {
        const turn = params.turn as CodexTurn | undefined
        this.finishTitleRun(sessionId, turn?.status === 'failed' ? undefined : titleRun.text)
      } else if (method === 'error') {
        this.finishTitleRun(sessionId)
      }
      return
    }
    switch (method) {
      case 'turn/started': {
        const turn = params.turn as CodexTurn | undefined
        if (turn?.id) {
          this.activeTurns.set(sessionId, turn.id)
          this.turnAssistantSegments.set(`${sessionId}:${turn.id}`, 0)
        }
        this.emit({ type: 'session.status', sessionID: sessionId, status: { type: 'busy' } })
        break
      }
      case 'turn/completed': {
        const turn = params.turn as CodexTurn | undefined
        if (turn?.status === 'failed') this.emit({ type: 'session.error', sessionID: sessionId, error: JSON.stringify((turn as unknown as { error?: unknown }).error ?? 'Codex turn failed') })
        // The ordinals only matter while the turn is streaming; the reload
        // derives them from turn.items. Dropping them here keeps a long-lived
        // server from retaining one entry per turn for the whole session.
        if (turn?.id) {
          const key = `${sessionId}:${turn.id}`
          this.turnUserItems.delete(key)
          this.turnAssistantSegments.delete(key)
          this.turnAssistantItems.delete(key)
        }
        this.activeTurns.delete(sessionId)
        this.emit({ type: 'session.status', sessionID: sessionId, status: { type: 'idle' } })
        this.emit({ type: 'session.idle', sessionID: sessionId })
        break
      }
      case 'item/started':
      case 'item/completed': {
        const item = params.item as CodexItem | undefined
        if (!item) break
        const turnId = String(params.turnId ?? '')
        if (item.type === 'userMessage') {
          this.emitUserMessage(
            sessionId,
            turnId,
            this.userMessageOrdinal(sessionId, turnId, item.id),
            item.content,
            Number(params.startedAtMs ?? Date.now())
          )
        } else {
          const messageId = this.assistantMessageId(sessionId, turnId, item.id)
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
        const turnId = String(params.turnId ?? '')
        const messageId = this.assistantMessageId(sessionId, turnId, itemId)
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
        for (const event of compactionCompletedEvents(sessionId, {
          trigger: this.manualCompactions.delete(sessionId) ? 'manual' : 'auto'
        })) this.emit(event)
        break
    }
  }

  async sessionsList(): Promise<SessionInfo[]> {
    const result = await this.request('thread/list', { cwd: this.projectPath || undefined, limit: 100 }) as { data?: CodexThread[] }
    return (result.data ?? []).map(threadInfo)
  }

  /** Put a thread in its own checkout. The manager calls this on every lookup
   *  with the path from the thread's own binding. */
  setSessionDirectory(id: string, directory: string, writableRoots: string[] = [directory]): void {
    this.sessionDirectories.set(id, directory)
    this.sessionWritableRoots.set(id, [...new Set(writableRoots)])
  }

  /** The sandbox goes out with each turn, so this lands on the next message
   *  rather than on a turn already in flight. */
  setSandbox(settings: SandboxSettings): void {
    this.sandboxSettings = { ...settings }
  }

  private directoryFor(sessionId: string): string | undefined {
    return this.sessionDirectories.resolve(sessionId, this.projectPath)
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
    this.sessionDirectories.forget(id)
    this.sessionWritableRoots.delete(id)
  }

  async sessionRename(id: string, title: string): Promise<SessionInfo> {
    await this.request('thread/name/set', { threadId: id, name: title })
    return { id, title, directory: this.projectPath, time: { updated: Date.now() } }
  }

  async sessionGet(id: string): Promise<SessionInfo> {
    const result = await this.request('thread/read', { threadId: id, includeTurns: false }) as { thread: CodexThread }
    return threadInfo(result.thread)
  }

  private finishTitleRun(threadId: string, title?: string): void {
    const run = this.titleRuns.get(threadId)
    if (!run) return
    clearTimeout(run.timer)
    this.titleRuns.delete(threadId)
    run.resolve(title?.trim() || undefined)
    void this.request('thread/unsubscribe', { threadId }, 5_000).catch(() => {})
  }

  /** A tiny structured turn in an ephemeral thread gives Codex backends the
   *  same semantic naming OpenCode gets from its built-in title agent. */
  async generateTitle(_sessionId: string, parts: unknown[], options?: ThreadTitleGenerationOptions): Promise<string | undefined> {
    const prompt = parts.flatMap((part) => {
      if (!part || typeof part !== 'object') return []
      const value = part as { type?: unknown; text?: unknown }
      return value.type === 'text' && typeof value.text === 'string' ? [value.text] : []
    }).join('\n').replace(/\s+/g, ' ').trim().slice(0, 1_600)
    if (!prompt) return undefined

    const started = await this.request('thread/start', {
      cwd: this.directoryFor(_sessionId),
      ephemeral: true,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      developerInstructions: 'Name the coding task in 2 to 5 specific words, at most 48 characters. Use a verb and the main subject. Do not copy conversational filler. Return only the requested JSON.'
    }) as { thread?: CodexThread }
    const threadId = started.thread?.id
    if (!threadId) return undefined

    return new Promise<string | undefined>((resolve) => {
      const timer = setTimeout(() => this.finishTitleRun(threadId), 12_000)
      timer.unref()
      this.titleRuns.set(threadId, { text: '', resolve, timer })
      const params: Record<string, unknown> = {
        threadId,
        input: [{ type: 'text', text: prompt }],
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        effort: 'low',
        outputSchema: {
          type: 'object',
          properties: { title: { type: 'string' } },
          required: ['title'],
          additionalProperties: false
        }
      }
      if (options?.model?.modelID) params.model = options.model.modelID
      void this.request('turn/start', params).catch(() => this.finishTitleRun(threadId))
    })
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
    const input = userInputs(parts)
    const params: Record<string, unknown> = {
      threadId: sessionId,
      input,
      cwd: this.directoryFor(sessionId),
      approvalPolicy: mode === 'auto' ? 'never' : 'on-request',
      sandboxPolicy: mode === 'plan'
        // Plan mode is offline whatever the setting says: a read-only thread
        // has no reason to reach the network.
        ? { type: 'readOnly', networkAccess: false }
        : {
            type: 'workspaceWrite',
            // Scoped to this thread's checkout. The global path would hand a
            // thread write access to a project it has nothing to do with.
            writableRoots: this.sessionWritableRoots.get(sessionId)
              ?? (() => { const dir = this.directoryFor(sessionId); return dir ? [dir] : [] })(),
            // Off blocks `gh pr create`, `npm install`, and every other
            // outbound call, while leaving `git push` — which needs no
            // sandbox network — untouched. Default on for that reason.
            networkAccess: this.sandboxSettings.networkAccess,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false
          }
    }
    if (options?.model?.modelID) params.model = options.model.modelID
    if (options?.model?.variant) params.effort = options.model.variant
    // Per turn, not per session: a thread can move to a worktree, and the
    // instructions set when it was created would still describe the old one.
    if (options?.context) params.developerInstructions = `${options.context}\n\n${QA_GUIDANCE}`
    const result = await this.request('turn/start', params) as { turn?: CodexTurn }
    if (result.turn?.id) {
      this.activeTurns.set(sessionId, result.turn.id)
      this.turnAssistantSegments.set(`${sessionId}:${result.turn.id}`, 0)
      this.emitUserMessage(
        sessionId,
        result.turn.id,
        0,
        input as CodexItem['content'],
        result.turn.startedAt ? result.turn.startedAt * 1000 : Date.now()
      )
    }
  }

  async steer(sessionId: string, parts: unknown[]): Promise<void> {
    const turnId = this.activeTurns.get(sessionId)
    if (!turnId) throw new Error('Codex no longer has an active turn to steer.')
    await this.request('turn/steer', {
      threadId: sessionId,
      expectedTurnId: turnId,
      input: userInputs(parts)
    })
    const key = `${sessionId}:${turnId}`
    this.turnAssistantSegments.set(key, (this.turnAssistantSegments.get(key) ?? 0) + 1)
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

  /** Codex takes its approval policy per turn, at turn/start, so a running turn
   *  cannot be told about a mode change.
   *
   *  In Auto it runs with approvalPolicy 'never' and stops sending approval
   *  requests altogether, so there is nothing to intercept either. The mode
   *  applies from the next turn, and saying so is better than a switch that
   *  silently does nothing. */
  async permissionModeSet(sessionId: string, _mode: BackendModeId): Promise<boolean> {
    return !this.activeTurns.has(sessionId)
  }

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
    const result = await this.request('thread/fork', { threadId: sessionId, cwd: this.directoryFor(sessionId) }) as { thread: CodexThread }
    this.loadedThreads.add(result.thread.id)
    return threadInfo(result.thread)
  }

  async revert(_sessionId: string, _messageId: string): Promise<void> {}
  async unrevert(_sessionId: string): Promise<void> {}
  async compact(sessionId: string): Promise<void> {
    await this.ensureLoaded(sessionId)
    this.manualCompactions.add(sessionId)
    try {
      await this.request('thread/compact/start', { threadId: sessionId }, 120_000)
    } catch (error) {
      this.manualCompactions.delete(sessionId)
      throw error
    }
  }
}
