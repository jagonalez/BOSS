import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { BackendModeId } from '@shared/backend'
import type { MessageWithParts } from '@shared/opencode'
// The explicit extensions keep this module executable under Node's type-stripping test runner.
// @ts-expect-error Application builds use bundler resolution.
import { configFromEnv } from './lab-config.ts'
// @ts-expect-error Application builds use bundler resolution.
import { LabEngine } from './lab-engine.ts'

/** An ACP (Agent Client Protocol) server for Lab: a JSONL-over-stdio agent
 *  that any ACP client (the same machinery BOSS uses for Claude Code) can
 *  drive. Lab runs its own tool loop; the client sends user prompts and answers
 *  permission prompts, and receives streamed assistant text, tool results, and
 *  a final result.
 *
 *  Subset implemented: initialize, set_permission_mode, user (text) messages,
 *  can_use_tool permission requests, assistant/stream_event/user(tool_result)
 *  output, and result. */

export type AcpWrite = (value: Record<string, unknown>) => void

export interface AcpEngineBundle {
  engine: LabEngine
  sessionId: string
  pendingPermissions: Map<string, (decision: 'allow' | 'deny') => void>
}

function contentBlocks(message: MessageWithParts): unknown[] {
  const blocks: unknown[] = []
  for (const part of message.parts) {
    if (part.type === 'text') blocks.push({ type: 'text', text: part.text ?? '' })
    else if (part.type === 'tool') blocks.push({ type: 'tool_use', id: part.id, name: part.state?.tool ?? 'tool', input: part.state?.input ?? {} })
  }
  return blocks
}

function acpModeToBoss(mode?: string): BackendModeId {
  switch (mode) {
    case 'auto': return 'auto'
    case 'acceptEdits': return 'accept-edits'
    case 'plan': return 'plan'
    default: return 'ask'
  }
}

function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? process.cwd()
}

/** Build a LabEngine wired to the ACP wire format. The session it returns is
 *  the one the server drives for the process's lifetime. */
export function createAcpEngine(write: AcpWrite, options: { storeFile?: string; configFile?: string } = {}): AcpEngineBundle {
  const pendingPermissions = new Map<string, (decision: 'allow' | 'deny') => void>()
  const engine = new LabEngine({
    storeFile: options.storeFile ?? join(homeDir(), '.lab', 'acp-threads.json'),
    configFile: options.configFile ?? join(homeDir(), '.lab', 'config.json'),
    config: configFromEnv(),
    sink: {
      onUserMessage: () => {},
      onAssistantMessage: (_sessionId, message) => write({ type: 'assistant', message: { id: message.info.id, content: contentBlocks(message) } }),
      onTextDelta: (_sessionId, _messageId, delta) => write({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta } } }),
      onReasoningDelta: (_sessionId, _messageId, _delta) => {},
      onToolPart: (_sessionId, part) => write({
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: part.id,
            content: typeof part.state?.output === 'string' ? part.state.output : '',
            is_error: part.state?.status === 'error'
          }]
        }
      }),
      onTodos: () => {},
      onBusy: () => {},
      onIdle: (_sessionId) => write({ type: 'result', subtype: 'success', result: { type: 'success' } }),
      onError: (_sessionId, error) => write({ type: 'result', subtype: 'error', result: { type: 'error', error } })
    },
    gate: {
      request: (_sessionId, call, args, signal) => new Promise<'allow' | 'deny'>((resolve) => {
        const requestId = `perm-${randomUUID()}`
        pendingPermissions.set(requestId, resolve)
        signal.addEventListener('abort', () => {
          if (pendingPermissions.delete(requestId)) resolve('deny')
        }, { once: true })
        write({
          type: 'control_request',
          request_id: requestId,
          request: {
            subtype: 'can_use_tool',
            tool_name: call.name,
            input: args,
            tool_use_id: call.id,
            permission_suggestions: [],
            title: call.name,
            description: ''
          }
        })
      })
    }
  })
  const session = engine.store.create('acp', globalThis.process.cwd())
  return { engine, sessionId: session.id, pendingPermissions }
}

/** Drive one ACP message from the client. Returns nothing; everything Lab
 *  produces goes out through the write callback. */
export class LabAcpServer {
  private readonly engine: LabEngine
  private readonly sessionId: string
  private readonly write: AcpWrite
  private readonly pendingPermissions: Map<string, (decision: 'allow' | 'deny') => void>
  private mode: BackendModeId = 'ask'

  constructor(
    engine: LabEngine,
    sessionId: string,
    write: AcpWrite,
    pendingPermissions: Map<string, (decision: 'allow' | 'deny') => void>
  ) {
    this.engine = engine
    this.sessionId = sessionId
    this.write = write
    this.pendingPermissions = pendingPermissions
  }

  handleLine(raw: string): void {
    let value: Record<string, unknown>
    try {
      value = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }
    if (value.type === 'control_request') {
      const request = value.request as Record<string, unknown> | undefined
      const requestId = String(value.request_id ?? '')
      if (request?.subtype === 'initialize') {
        this.write({ type: 'control_response', request_id: requestId, response: { subtype: 'success' } })
        return
      }
      if (request?.subtype === 'set_permission_mode') {
        this.mode = acpModeToBoss(String(request.mode ?? ''))
        this.engine.setPermissionMode(this.sessionId, this.mode)
        this.write({ type: 'control_response', request_id: requestId, response: { subtype: 'success' } })
        return
      }
      return
    }
    if (value.type === 'control_response') {
      const response = value.response as Record<string, unknown> | undefined
      const requestId = String(response?.request_id ?? '')
      const pending = this.pendingPermissions.get(requestId)
      if (pending) {
        this.pendingPermissions.delete(requestId)
        const decision = (response?.response as Record<string, unknown> | undefined)?.behavior
        pending(decision === 'allow' ? 'allow' : 'deny')
      }
      return
    }
    if (value.type === 'user') {
      const message = value.message as Record<string, unknown> | undefined
      const content = Array.isArray(message?.content) ? message.content : []
      const text = content
        .flatMap((block) => {
          if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') return [(block as { text?: string }).text ?? '']
          return []
        })
        .join('\n')
        .trim()
      if (!text) return
      // The engine streams the reply and closes the turn with a result event.
      void this.engine.sendMessage(this.sessionId, text, { mode: this.mode }).catch(() => {})
    }
  }
}

/** Start the ACP server over stdin/stdout. Keeps the process alive until
 *  stdin closes or SIGINT aborts the current run. */
export function runAcp(options: { storeFile?: string; configFile?: string } = {}): void {
  const storeFile = options.storeFile ?? join(homeDir(), '.lab', 'acp-threads.json')
  mkdirSync(dirname(storeFile), { recursive: true })
  const write = (value: Record<string, unknown>): void => {
    process.stdout.write(`${JSON.stringify(value)}\n`)
  }
  const bundle = createAcpEngine(write, { ...options, storeFile })
  const server = new LabAcpServer(bundle.engine, bundle.sessionId, write, bundle.pendingPermissions)
  process.on('SIGINT', () => bundle.engine.abort(bundle.sessionId))
  const rl = createInterface({ input: process.stdin })
  rl.on('line', (line) => {
    if (line.trim()) server.handleLine(line)
  })
}