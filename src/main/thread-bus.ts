import { app } from 'electron'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BackendId } from '@shared/backend'
import type { MessageWithParts } from '@shared/opencode'
import { QA_GUIDANCE, QA_TOOL_DEFINITIONS, isAgentToolResult, type QaAgentTool, type QaPolicy } from '@shared/qa'
import type {
  CollaborationPolicy,
  ThreadBusAgentTool,
  ThreadBusConnection,
  ThreadBusMessage,
  ThreadBusSnapshot,
  ThreadBusThread
} from '@shared/thread-bus'
import { projectScope } from './project-identity'
import type { QaTools } from './qa-tools'
import { MCP_TOOL_PREFIX } from '@shared/mcp'
import type { McpHub } from './mcp-hub'
import type { TeamBoardManager } from './team-board-manager'
import { TEAM_AGENT_TOOL_DEFINITIONS } from '@shared/team'

interface LegacyThreadBusState {
  version: 1
  policies: Record<string, CollaborationPolicy>
  messages: Array<Omit<ThreadBusMessage, 'projectId'>>
}

interface StoredThreadBusState {
  version: 2
  policies: Record<string, CollaborationPolicy>
  messages: ThreadBusMessage[]
}

export interface ThreadBusHost {
  threadForNative(backendId: BackendId, nativeThreadId: string): ThreadBusThread | undefined
  threadInfo(threadId: string): ThreadBusThread | undefined
  threadList(projectId: string): ThreadBusThread[]
  threadMessages(threadId: string, limit: number): Promise<MessageWithParts[]>
  deliverThreadMessage(threadId: string, body: string): Promise<void>
  spawnWorktreeThread(threadId: string, instruction: string): Promise<ThreadBusThread>
  emitThreadBus(snapshot: ThreadBusSnapshot): void
}

const MAX_MESSAGES = 500
const MAX_BODY = 16_000
const MAX_QUEUE_PER_THREAD = 25

function stateFile(): string {
  return join(app.getPath('userData'), 'thread-bus.json')
}

function messageText(messages: MessageWithParts[]): string {
  return messages.map((message) => {
    const text = message.parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .filter(Boolean)
      .join('\n')
    return text ? `${message.info.role === 'user' ? 'USER' : 'ASSISTANT'}:\n${text}` : ''
  }).filter(Boolean).join('\n\n').slice(-24_000)
}

function stringArg(value: unknown, key: string): string {
  if (!value || typeof value !== 'object') return ''
  const result = (value as Record<string, unknown>)[key]
  return typeof result === 'string' ? result.trim() : ''
}

function numberArg(value: unknown, key: string, fallback: number): number {
  if (!value || typeof value !== 'object') return fallback
  const result = Number((value as Record<string, unknown>)[key])
  return Number.isFinite(result) ? result : fallback
}

function booleanArg(value: unknown, key: string, fallback: boolean): boolean {
  if (!value || typeof value !== 'object') return fallback
  const result = (value as Record<string, unknown>)[key]
  return typeof result === 'boolean' ? result : fallback
}

export class ThreadBus {
  private readonly policies: Record<string, CollaborationPolicy> = {}
  private messages: ThreadBusMessage[] = []
  private server: Server | null = null
  private token = ''
  private port = 0
  private readonly deliveryLocks = new Set<string>()
  private qaTools?: QaTools
  private mcpHub?: McpHub
  private teamBoards?: TeamBoardManager

  constructor(private readonly host: ThreadBusHost) {
    this.load()
  }

  attachQaTools(qaTools: QaTools): void {
    this.qaTools = qaTools
  }

  attachMcpHub(mcpHub: McpHub): void {
    this.mcpHub = mcpHub
  }

  attachTeamBoards(teamBoards: TeamBoardManager): void {
    this.teamBoards = teamBoards
  }

  qaStatus(threadId: string) {
    if (!this.qaTools) throw new Error('QA tools are not available.')
    return this.qaTools.status(threadId)
  }

  setQaPolicy(threadId: string, policy: QaPolicy | null) {
    if (!this.qaTools) throw new Error('QA tools are not available.')
    return this.qaTools.setPolicy(threadId, policy)
  }

  qaDefault(): QaPolicy {
    if (!this.qaTools) throw new Error('QA tools are not available.')
    return this.qaTools.default()
  }

  setQaDefault(policy: QaPolicy) {
    if (!this.qaTools) throw new Error('QA tools are not available.')
    return this.qaTools.setDefault(policy)
  }

  private load(): void {
    try {
      const state = JSON.parse(readFileSync(stateFile(), 'utf8')) as StoredThreadBusState | LegacyThreadBusState
      if (state.version === 2) {
        Object.assign(this.policies, state.policies)
        this.messages = Array.isArray(state.messages) ? state.messages.slice(-MAX_MESSAGES) : []
        return
      }
      if (state.version === 1) {
        for (const [path, policy] of Object.entries(state.policies)) {
          this.policies[projectScope(path).projectId] = policy
        }
        this.messages = Array.isArray(state.messages)
          ? state.messages.slice(-MAX_MESSAGES).map((message) => {
            const scope = projectScope(message.projectPath)
            return { ...message, projectId: scope.projectId, projectPath: scope.projectPath }
          })
          : []
        this.save()
      }
    } catch {
      /* First launch starts with collaboration disabled. */
    }
  }

  private save(): void {
    const state: StoredThreadBusState = {
      version: 2,
      policies: this.policies,
      messages: this.messages.slice(-MAX_MESSAGES)
    }
    try {
      writeFileSync(stateFile(), JSON.stringify(state, null, 2))
    } catch {
      /* The in-memory broker remains usable if persistence is unavailable. */
    }
  }

  policy(projectId: string): CollaborationPolicy {
    return this.policies[projectId] ?? 'off'
  }

  setPolicy(projectId: string, projectPath: string, policy: CollaborationPolicy): ThreadBusSnapshot {
    this.policies[projectId] = policy
    this.save()
    return this.publish(projectId, projectPath)
  }

  clearFailures(projectId: string, projectPath: string): ThreadBusSnapshot {
    this.messages = this.messages.filter((message) => message.status !== 'failed' || message.projectId !== projectId)
    this.save()
    return this.publish(projectId, projectPath)
  }

  snapshot(projectId: string, projectPath: string): ThreadBusSnapshot {
    const messages = this.messages.filter((message) => message.projectId === projectId).slice(-100)
    return {
      projectId,
      projectPath,
      policy: this.policy(projectId),
      threads: this.host.threadList(projectId),
      messages,
      toolBackends: ['opencode', 'pi', 'codex', 'claude']
    }
  }

  private publish(projectId: string, projectPath: string): ThreadBusSnapshot {
    const snapshot = this.snapshot(projectId, projectPath)
    this.host.emitThreadBus(snapshot)
    return snapshot
  }

  async agentCall(backendId: BackendId, nativeThreadId: string, tool: ThreadBusAgentTool, args: unknown): Promise<unknown> {
    const caller = this.host.threadForNative(backendId, nativeThreadId)
    if (!caller) throw new Error('R.A.L.F. could not identify the calling thread.')
    if (tool.startsWith('ralf_browser_') || tool === 'ralf_computer') {
      if (!this.qaTools) throw new Error('R.A.L.F. QA tools are not ready.')
      return this.qaTools.call(caller.id, tool as QaAgentTool, args)
    }
    if (tool.startsWith(MCP_TOOL_PREFIX) || tool === 'ralf_mcp_list' || tool === 'ralf_mcp_call') {
      if (!this.mcpHub) throw new Error('R.A.L.F. MCP connections are not ready.')
      if (tool === 'ralf_mcp_list') return this.mcpHub.agentListing(stringArg(args, 'tool') || undefined)
      if (tool === 'ralf_mcp_call') {
        const name = stringArg(args, 'tool')
        if (!name) throw new Error('Pass the tool name from ralf_mcp_list.')
        const argumentsJson = stringArg(args, 'argumentsJson')
        const inline = (args as Record<string, unknown> | undefined)?.arguments
        let toolArgs: unknown = inline && typeof inline === 'object' ? inline : {}
        if (argumentsJson) {
          try {
            toolArgs = JSON.parse(argumentsJson)
          } catch {
            throw new Error('argumentsJson must be a valid JSON object.')
          }
        }
        return this.mcpHub.callAgentTool(name, toolArgs)
      }
      return this.mcpHub.callAgentTool(tool, args)
    }
    if (tool.startsWith('ralf_team_')) {
      if (!this.teamBoards) throw new Error('R.A.L.F. Team Board is not ready.')
      return this.teamBoards.agentCall(caller.id, tool as import('@shared/team').TeamAgentTool, args)
    }
    const policy = this.policy(caller.projectId)
    if (policy === 'off') throw new Error('Thread collaboration is disabled for this project.')
    if (!['ralf_threads_list', 'ralf_threads_read', 'ralf_threads_send', 'ralf_threads_reply', 'ralf_threads_spawn_worktree'].includes(tool)) {
      throw new Error('Unknown R.A.L.F. thread tool.')
    }

    switch (tool) {
      case 'ralf_threads_list':
        return this.host.threadList(caller.projectId)
          .filter((thread) => thread.backendId === caller.backendId)
          .map((thread) => ({ id: thread.id, title: thread.title, busy: thread.busy, current: thread.id === caller.id }))
      case 'ralf_threads_read': {
        const targetId = stringArg(args, 'threadId')
        const target = this.requirePeer(caller, targetId)
        const limit = Math.max(1, Math.min(20, numberArg(args, 'limit', 8)))
        const messages = await this.host.threadMessages(target.id, limit)
        return {
          thread: { id: target.id, title: target.title, busy: target.busy },
          transcript: messageText(messages) || '(No messages yet.)'
        }
      }
      case 'ralf_threads_send':
        if (policy !== 'collaborate') throw new Error('This project allows reading threads, but not sending messages.')
        return this.send(caller, stringArg(args, 'threadId'), stringArg(args, 'message'), {
          expectsReply: booleanArg(args, 'expectsReply', true),
          maxTurns: numberArg(args, 'maxTurns', 4)
        })
      case 'ralf_threads_reply': {
        if (policy !== 'collaborate') throw new Error('This project allows reading threads, but not sending replies.')
        const replyTo = this.messages.find((message) => message.id === stringArg(args, 'messageId'))
        if (!replyTo || replyTo.toThreadId !== caller.id) throw new Error('That message is not addressed to this thread.')
        if (replyTo.hopCount + 1 >= replyTo.maxTurns) throw new Error('This conversation reached its configured turn limit.')
        if (this.messages.some((message) => message.replyTo === replyTo.id && message.fromThreadId === caller.id)) {
          throw new Error('This thread already replied to that message.')
        }
        return this.send(caller, replyTo.fromThreadId, stringArg(args, 'message'), {
          expectsReply: booleanArg(args, 'expectsReply', false),
          maxTurns: replyTo.maxTurns,
          replyTo: replyTo.id,
          rootId: replyTo.rootId,
          hopCount: replyTo.hopCount + 1
        })
      }
      case 'ralf_threads_spawn_worktree': {
        if (policy !== 'collaborate') throw new Error('This project does not allow agents to create worktree threads.')
        const instruction = stringArg(args, 'instruction')
        if (!instruction) throw new Error('An implementation instruction is required.')
        if (instruction.length > MAX_BODY) throw new Error(`Instructions are limited to ${MAX_BODY.toLocaleString()} characters.`)
        return this.host.spawnWorktreeThread(caller.id, instruction)
      }
    }
  }

  private requirePeer(caller: ThreadBusThread, targetId: string): ThreadBusThread {
    if (!targetId) throw new Error('A target thread id is required.')
    if (caller.id === targetId) throw new Error('Choose a different thread.')
    const target = this.host.threadInfo(targetId)
    if (!target) throw new Error('Target thread not found.')
    if (target.backendId !== caller.backendId) throw new Error('Agent communication is limited to threads on the same backend.')
    if (target.projectId !== caller.projectId) throw new Error('Agent communication is limited to threads in the same project.')
    return target
  }

  private async send(
    caller: ThreadBusThread,
    targetId: string,
    body: string,
    options: { expectsReply: boolean; maxTurns: number; replyTo?: string; rootId?: string; hopCount?: number }
  ): Promise<ThreadBusMessage> {
    const target = this.requirePeer(caller, targetId)
    if (!body) throw new Error('A message is required.')
    if (body.length > MAX_BODY) throw new Error(`Messages are limited to ${MAX_BODY.toLocaleString()} characters.`)
    const queued = this.messages.filter((message) => message.toThreadId === target.id && message.status === 'queued')
    if (queued.length >= MAX_QUEUE_PER_THREAD) throw new Error('The target thread queue is full.')
    const maxTurns = Math.max(1, Math.min(8, Math.round(options.maxTurns)))
    const id = randomUUID()
    const message: ThreadBusMessage = {
      id,
      rootId: options.rootId ?? id,
      fromThreadId: caller.id,
      toThreadId: target.id,
      backendId: caller.backendId,
      projectId: caller.projectId,
      projectPath: caller.projectPath,
      body,
      createdAt: Date.now(),
      status: 'queued',
      replyTo: options.replyTo,
      expectsReply: options.expectsReply,
      hopCount: options.hopCount ?? 0,
      maxTurns
    }
    this.messages.push(message)
    this.save()
    this.publish(caller.projectId, caller.projectPath)
    if (!target.busy && !this.deliveryLocks.has(target.id)) await this.deliver(message)
    return message
  }

  private prompt(message: ThreadBusMessage): string {
    const source = this.host.threadInfo(message.fromThreadId)
    return [
      '[R.A.L.F. THREAD MESSAGE]',
      `From: ${source?.title ?? message.fromThreadId} (${message.fromThreadId})`,
      `Message id: ${message.id}`,
      `Conversation turn: ${message.hopCount + 1} of ${message.maxTurns}`,
      message.body,
      message.expectsReply
        ? 'A reply was requested. Use ralf_threads_reply with this message id; do not simulate a reply in another thread.'
        : 'No reply is required. Reply only if it materially helps the sending thread.'
    ].join('\n\n')
  }

  private async deliver(message: ThreadBusMessage): Promise<void> {
    this.deliveryLocks.add(message.toThreadId)
    try {
      await this.host.deliverThreadMessage(message.toThreadId, this.prompt(message))
      message.status = 'delivered'
      message.deliveredAt = Date.now()
      delete message.error
    } catch (error) {
      message.status = 'failed'
      message.error = error instanceof Error ? error.message : String(error)
      this.deliveryLocks.delete(message.toThreadId)
    }
    this.save()
    this.publish(message.projectId, message.projectPath)
  }

  async flush(threadId: string): Promise<void> {
    this.deliveryLocks.delete(threadId)
    const message = this.messages.find((item) => item.toThreadId === threadId && item.status === 'queued')
    const target = this.host.threadInfo(threadId)
    if (message && target && !target.busy) await this.deliver(message)
  }

  async resume(): Promise<void> {
    const targets = [...new Set(this.messages.filter((message) => message.status === 'queued').map((message) => message.toThreadId))]
    for (const threadId of targets) await this.flush(threadId)
  }

  private callerToken(backendId: BackendId, nativeThreadId: string): string {
    return createHmac('sha256', this.token).update(`${backendId}\0${nativeThreadId}`).digest('hex')
  }

  private authorized(request: IncomingMessage, backendId?: BackendId, nativeThreadId?: string): boolean {
    const authorization = request.headers.authorization
    if (authorization === `Bearer ${this.token}`) return true
    if (!backendId || !nativeThreadId || typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return false
    const supplied = Buffer.from(authorization.slice(7))
    const expected = Buffer.from(this.callerToken(backendId, nativeThreadId))
    return supplied.length === expected.length && timingSafeEqual(supplied, expected)
  }

  private localOrigin(request: IncomingMessage): boolean {
    const origin = request.headers.origin
    if (!origin) return true
    try {
      const hostname = new URL(origin).hostname
      return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
    } catch {
      return false
    }
  }

  private async requestBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolveBody, reject) => {
      let body = ''
      let tooLarge = false
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => {
        body += chunk
        if (body.length > 64_000) tooLarge = true
      })
      request.on('end', () => tooLarge ? reject(new Error('Thread-bus request is too large.')) : resolveBody(body))
      request.on('error', reject)
    })
  }

  private json(response: ServerResponse, status: number, value?: unknown): void {
    if (value === undefined) {
      response.writeHead(status).end()
      return
    }
    response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
  }

  private async handleAgentCall(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST') {
      this.json(response, 404)
      return
    }
    try {
      const input = JSON.parse(await this.requestBody(request)) as { backendId?: BackendId; nativeThreadId?: string; tool?: ThreadBusAgentTool; arguments?: unknown }
      if (!input.backendId || !input.nativeThreadId || !input.tool) throw new Error('Invalid thread-bus request.')
      if (!this.authorized(request, input.backendId, input.nativeThreadId)) {
        this.json(response, 404)
        return
      }
      const result = await this.agentCall(input.backendId, input.nativeThreadId, input.tool, input.arguments)
      this.json(response, 200, { ok: true, result })
    } catch (error) {
      this.json(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  private mcpTools(): Array<Record<string, unknown>> {
    const threadId = { type: 'string', description: 'R.A.L.F. thread id returned by ralf_threads_list.' }
    const message = { type: 'string', description: 'Message to send to the other agent.' }
    return [
      {
        name: 'ralf_threads_list',
        description: 'List other threads in this project that use the same backend.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true }
      },
      {
        name: 'ralf_threads_read',
        description: 'Read recent messages from another same-project, same-backend thread.',
        inputSchema: {
          type: 'object',
          properties: { threadId, limit: { type: 'integer', minimum: 1, maximum: 20, default: 8 } },
          required: ['threadId'],
          additionalProperties: false
        },
        annotations: { readOnlyHint: true }
      },
      {
        name: 'ralf_threads_send',
        description: 'Send a bounded message to another same-project, same-backend thread.',
        inputSchema: {
          type: 'object',
          properties: {
            threadId,
            message,
            expectsReply: { type: 'boolean', default: true },
            maxTurns: { type: 'integer', minimum: 1, maximum: 8, default: 4 }
          },
          required: ['threadId', 'message'],
          additionalProperties: false
        }
      },
      {
        name: 'ralf_threads_reply',
        description: 'Reply once to a R.A.L.F. thread message addressed to this thread.',
        inputSchema: {
          type: 'object',
          properties: {
            messageId: { type: 'string', description: 'Message id from the incoming R.A.L.F. thread message.' },
            message,
            expectsReply: { type: 'boolean', default: false }
          },
          required: ['messageId', 'message'],
          additionalProperties: false
        }
      },
      {
        name: 'ralf_threads_spawn_worktree',
        description: 'Fork this conversation into a new R.A.L.F. thread running in an isolated Git worktree.',
        inputSchema: {
          type: 'object',
          properties: {
            instruction: { type: 'string', description: 'The concrete task the new worktree thread should implement.' }
          },
          required: ['instruction'],
          additionalProperties: false
        }
      },
      ...TEAM_AGENT_TOOL_DEFINITIONS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: tool.readOnly }
      })),
      ...QA_TOOL_DEFINITIONS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: tool.readOnly }
      })),
      ...(this.mcpHub?.agentToolDefinitions() ?? [])
    ]
  }

  private async handleMcp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const nativeThreadId = request.headers['x-ralf-thread']
    const backendId = request.headers['x-ralf-backend']
    if (backendId !== 'claude' || typeof nativeThreadId !== 'string' || !this.authorized(request, 'claude', nativeThreadId)) {
      this.json(response, 404)
      return
    }
    if (!this.localOrigin(request)) {
      this.json(response, 403)
      return
    }
    if (request.method === 'GET' || request.method === 'DELETE') {
      response.writeHead(405, { allow: 'POST' }).end()
      return
    }
    if (request.method !== 'POST') {
      this.json(response, 404)
      return
    }
    let input: { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }
    try {
      input = JSON.parse(await this.requestBody(request)) as typeof input
    } catch (error) {
      this.json(response, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: error instanceof Error ? error.message : 'Invalid JSON.' } })
      return
    }
    if (input.jsonrpc !== '2.0' || !input.method) {
      this.json(response, 400, { jsonrpc: '2.0', id: input.id ?? null, error: { code: -32600, message: 'Invalid JSON-RPC request.' } })
      return
    }
    if (input.id === undefined) {
      this.json(response, 202)
      return
    }

    const reply = (result: unknown): void => this.json(response, 200, { jsonrpc: '2.0', id: input.id, result })
    if (input.method === 'initialize') {
      const requested = typeof input.params?.protocolVersion === 'string' ? input.params.protocolVersion : ''
      const hubInstructions = this.mcpHub?.instructionsSummary()
      reply({
        protocolVersion: requested === '2025-03-26' ? requested : '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'ralf-agent-tools', version: '1.0.0' },
        instructions: hubInstructions ? `${QA_GUIDANCE}\n\n${hubInstructions}` : QA_GUIDANCE
      })
      return
    }
    if (input.method === 'tools/list') {
      reply({ tools: this.mcpTools() })
      return
    }
    if (input.method === 'tools/call') {
      const name = input.params?.name
      if (typeof name !== 'string') {
        reply({ content: [{ type: 'text', text: 'R.A.L.F. could not identify the calling Claude thread.' }], isError: true })
        return
      }
      try {
        const result = await this.agentCall('claude', nativeThreadId, name as ThreadBusAgentTool, input.params?.arguments)
        if (isAgentToolResult(result)) {
          reply({
            content: [
              { type: 'text', text: result.text },
              ...(result.image ? [{ type: 'image', mimeType: result.image.mimeType, data: result.image.data }] : [])
            ],
            isError: false
          })
        } else {
          reply({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: false })
        }
      } catch (error) {
        reply({ content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true })
      }
      return
    }
    this.json(response, 200, { jsonrpc: '2.0', id: input.id, error: { code: -32601, message: 'Method not found.' } })
  }

  private connection(): ThreadBusConnection {
    return {
      url: `http://127.0.0.1:${this.port}`,
      token: this.token,
      tokenFor: (backendId, nativeThreadId) => this.callerToken(backendId, nativeThreadId),
      agentToolNames: () => (this.mcpHub?.agentToolDefinitions() ?? []).map((definition) => definition.name)
    }
  }

  async start(): Promise<ThreadBusConnection> {
    if (this.server) return this.connection()
    this.token = randomBytes(32).toString('hex')
    this.server = createServer((request, response) => {
      if (request.url === '/agent-call') {
        void this.handleAgentCall(request, response)
        return
      }
      if (request.url === '/mcp') {
        void this.handleMcp(request, response)
        return
      }
      response.writeHead(404).end()
    })
    await new Promise<void>((resolveStart, reject) => {
      this.server?.once('error', reject)
      this.server?.listen(0, '127.0.0.1', () => {
        const address = this.server?.address()
        this.port = typeof address === 'object' && address ? address.port : 0
        resolveStart()
      })
    })
    return this.connection()
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (server) await new Promise<void>((resolveStop) => server.close(() => resolveStop()))
  }
}
