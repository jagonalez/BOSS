import type { BackendId } from './backend'

export type CollaborationPolicy = 'off' | 'read' | 'collaborate'
export type ThreadBusMessageStatus = 'queued' | 'delivered' | 'failed'

export interface ThreadBusThread {
  id: string
  title: string
  backendId: BackendId
  projectPath: string
  busy: boolean
}

export interface ThreadBusMessage {
  id: string
  rootId: string
  fromThreadId: string
  toThreadId: string
  backendId: BackendId
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
  projectPath: string
  policy: CollaborationPolicy
  threads: ThreadBusThread[]
  messages: ThreadBusMessage[]
  toolBackends: BackendId[]
}

export type ThreadBusAgentTool =
  | 'ralf_threads_list'
  | 'ralf_threads_read'
  | 'ralf_threads_send'
  | 'ralf_threads_reply'

export interface ThreadBusToolCall {
  nativeThreadId: string
  tool: ThreadBusAgentTool
  arguments: unknown
}
