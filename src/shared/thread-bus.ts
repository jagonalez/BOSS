import type { BackendId } from './backend'
import type { QaAgentTool } from './qa'

export type CollaborationPolicy = 'off' | 'read' | 'collaborate'
export type ThreadBusMessageStatus = 'queued' | 'delivered' | 'failed'

export interface ThreadBusThread {
  id: string
  title: string
  backendId: BackendId
  projectId: string
  projectPath: string
  executionPath: string
  busy: boolean
}

export interface ThreadBusMessage {
  id: string
  rootId: string
  fromThreadId: string
  toThreadId: string
  backendId: BackendId
  projectId: string
  projectPath: string
  body: string
  createdAt: number
  deliveredAt?: number
  status: ThreadBusMessageStatus
  error?: string
  replyTo?: string
  expectsReply: boolean
  hopCount: number
  maxTurns: number
}

export interface ThreadBusSnapshot {
  projectId: string
  projectPath: string
  policy: CollaborationPolicy
  threads: ThreadBusThread[]
  messages: ThreadBusMessage[]
  toolBackends: BackendId[]
}

export interface ThreadBusConnection {
  url: string
  token: string
  tokenFor(backendId: BackendId, nativeThreadId: string): string
  /** Names of MCP-hub tools currently available to agents, mcp_<slug>_<tool>. */
  agentToolNames(): string[]
}

export type ThreadBusAgentTool =
  | 'boss_threads_list'
  | 'boss_threads_read'
  | 'boss_threads_send'
  | 'boss_threads_reply'
  | 'boss_threads_spawn_worktree'
  | 'boss_mcp_list'
  | 'boss_mcp_call'
  | `mcp_${string}`
  | QaAgentTool

export interface ThreadBusToolCall {
  nativeThreadId: string
  tool: ThreadBusAgentTool
  arguments: unknown
}
