import { app } from 'electron'
import { createServer, type Server } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { BackendId } from '@shared/backend'
import type { MessageWithParts } from '@shared/opencode'
import type {
  CollaborationPolicy,
  ThreadBusAgentTool,
  ThreadBusMessage,
  ThreadBusSnapshot,
  ThreadBusThread
} from '@shared/thread-bus'

interface StoredThreadBusState {
  version: 1
  policies: Record<string, CollaborationPolicy>
  messages: ThreadBusMessage[]
}

export interface ThreadBusHost {
  threadForNative(backendId: BackendId, nativeThreadId: string): ThreadBusThread | undefined
  threadInfo(threadId: string): ThreadBusThread | undefined
  threadList(projectPath: string): ThreadBusThread[]
  threadMessages(threadId: string, limit: number): Promise<MessageWithParts[]>
  deliverThreadMessage(threadId: string, body: string): Promise<void>
  emitThreadBus(snapshot: ThreadBusSnapshot): void
}

export interface ThreadBusConnection {
  url: string
  token: string
}

const MAX_MESSAGES = 500
const MAX_BODY = 16_000
const MAX_QUEUE_PER_THREAD = 25

function stateFile(): string {
  return join(app.getPath('userData'), 'thread-bus.json')
}

function projectKey(path: string): string {
  return path ? resolve(path) : ''
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

  constructor(private readonly host: ThreadBusHost) {
    this.load()
  }

  private load(): void {
    try {
      const state = JSON.parse(readFileSync(stateFile(), 'utf8')) as StoredThreadBusState
      if (state.version !== 1) return
      Object.assign(this.policies, state.policies)
      this.messages = Array.isArray(state.messages) ? state.messages.slice(-MAX_MESSAGES) : []
    } catch {
      /* First launch starts with collaboration disabled. */
    }
  }

  private save(): void {
    const state: StoredThreadBusState = {
      version: 1,
      policies: this.policies,
      messages: this.messages.slice(-MAX_MESSAGES)
    }
    try {
      writeFileSync(stateFile(), JSON.stringify(state, null, 2))
    } catch {
      /* The in-memory broker remains usable if persistence is unavailable. */
    }
  }

  policy(path: string): CollaborationPolicy {
    return this.policies[projectKey(path)] ?? 'off'
  }

  setPolicy(path: string, policy: CollaborationPolicy): ThreadBusSnapshot {
    this.policies[projectKey(path)] = policy
    this.save()
    return this.publish(path)
  }

  clearFailures(path: string): ThreadBusSnapshot {
    const key = projectKey(path)
    this.messages = this.messages.filter((message) => message.status !== 'failed' || projectKey(message.projectPath) !== key)
    this.save()
    return this.publish(path)
  }

  snapshot(path: string): ThreadBusSnapshot {
    const key = projectKey(path)
    const messages = this.messages.filter((message) => projectKey(message.projectPath) === key).slice(-100)
    return {
      projectPath: path,
      policy: this.policy(path),
      threads: this.host.threadList(path),
      messages,
      toolBackends: ['opencode', 'codex']
    }
  }

  private publish(path: string): ThreadBusSnapshot {
    const snapshot = this.snapshot(path)
    this.host.emitThreadBus(snapshot)
    return snapshot
  }

  async agentCall(backendId: BackendId, nativeThreadId: string, tool: ThreadBusAgentTool, args: unknown): Promise<unknown> {
    const caller = this.host.threadForNative(backendId, nativeThreadId)
    if (!caller) throw new Error('R.A.L.F. could not identify the calling thread.')
    const policy = this.policy(caller.projectPath)
    if (policy === 'off') throw new Error('Thread collaboration is disabled for this project.')
    if (!['ralf_threads_list', 'ralf_threads_read', 'ralf_threads_send', 'ralf_threads_reply'].includes(tool)) {
      throw new Error('Unknown R.A.L.F. thread tool.')
    }

    switch (tool) {
      case 'ralf_threads_list':
        return this.host.threadList(caller.projectPath)
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
    }
  }

  private requirePeer(caller: ThreadBusThread, targetId: string): ThreadBusThread {
    if (!targetId) throw new Error('A target thread id is required.')
    if (caller.id === targetId) throw new Error('Choose a different thread.')
    const target = this.host.threadInfo(targetId)
    if (!target) throw new Error('Target thread not found.')
    if (target.backendId !== caller.backendId) throw new Error('Agent communication is limited to threads on the same backend.')
    if (projectKey(target.projectPath) !== projectKey(caller.projectPath)) throw new Error('Agent communication is limited to threads in the same project.')
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
    this.publish(caller.projectPath)
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
    this.publish(message.projectPath)
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

  async start(): Promise<ThreadBusConnection> {
    if (this.server) return { url: `http://127.0.0.1:${this.port}`, token: this.token }
    this.token = randomBytes(32).toString('hex')
    this.server = createServer((request, response) => {
      if (request.method !== 'POST' || request.url !== '/agent-call' || request.headers.authorization !== `Bearer ${this.token}`) {
        response.writeHead(404).end()
        return
      }
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => {
        body += chunk
        if (body.length > 64_000) request.destroy()
      })
      request.on('end', () => {
        void (async () => {
          try {
            const input = JSON.parse(body) as { backendId?: BackendId; nativeThreadId?: string; tool?: ThreadBusAgentTool; arguments?: unknown }
            if (!input.backendId || !input.nativeThreadId || !input.tool) throw new Error('Invalid thread-bus request.')
            const result = await this.agentCall(input.backendId, input.nativeThreadId, input.tool, input.arguments)
            response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result }))
          } catch (error) {
            response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
          }
        })()
      })
    })
    await new Promise<void>((resolveStart, reject) => {
      this.server?.once('error', reject)
      this.server?.listen(0, '127.0.0.1', () => {
        const address = this.server?.address()
        this.port = typeof address === 'object' && address ? address.port : 0
        resolveStart()
      })
    })
    return { url: `http://127.0.0.1:${this.port}`, token: this.token }
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (server) await new Promise<void>((resolveStop) => server.close(() => resolveStop()))
  }
}
