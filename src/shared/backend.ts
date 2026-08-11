export type BackendId = 'opencode' | 'pi' | 'codex' | 'claude'
export type BackendModeId = 'ask' | 'auto' | 'plan' | 'accept-edits'
export type ThreadCreationScope = 'current' | 'global'

export interface BackendModeDescriptor {
  id: BackendModeId
  label: string
  description: string
}

export interface BackendCapabilities {
  streaming: boolean
  models: boolean
  permissions: boolean
  nativeFork: boolean
  images: boolean
  mcp: boolean
  interactiveQuestions: boolean
}

export interface BackendDescriptor {
  id: BackendId
  label: string
  description: string
  available: boolean
  healthy: boolean
  version?: string
  command?: string
  unavailableReason?: string
  capabilities: BackendCapabilities
  modes: BackendModeDescriptor[]
}

export interface BackendMessageOptions {
  model?: { providerID: string; modelID: string; variant?: string }
  agent?: string
  mode?: BackendModeId
}

export type BackendRequest =
  | { type: 'backend.list' }
  | { type: 'thread.list' }
  | { type: 'thread.create'; backendId: BackendId; title?: string; scope?: ThreadCreationScope }
  | { type: 'thread.import-native'; backendId: BackendId }
  | { type: 'thread.get'; threadId: string }
  | { type: 'thread.delete'; threadId: string }
  | { type: 'thread.rename'; threadId: string; title: string }
  | { type: 'thread.messages'; threadId: string; limit?: number }
  | { type: 'thread.send'; threadId: string; parts: unknown[]; options?: BackendMessageOptions }
  | { type: 'thread.abort'; threadId: string }
  | { type: 'thread.todos'; threadId: string }
  | { type: 'thread.permission'; threadId: string; permissionId: string; response: 'once' | 'always' | 'reject' }
  | { type: 'thread.diff'; threadId: string; messageId?: string }
  | { type: 'thread.fork'; threadId: string; messageId?: string }
  | { type: 'thread.revert'; threadId: string; messageId: string }
  | { type: 'thread.unrevert'; threadId: string }
  | { type: 'thread.command'; threadId: string; command: string; arguments: string; options?: BackendMessageOptions }
  | { type: 'thread.compact'; threadId: string; model?: { providerID: string; modelID: string } }
  | { type: 'thread.models'; threadId?: string; backendId?: BackendId }
  | { type: 'thread.clone'; threadId: string; backendId: BackendId; instruction?: string }
  | { type: 'thread.worktree.create'; threadId: string; messageId?: string; instruction?: string }
  | { type: 'worktree.list'; threadId?: string }
  | { type: 'worktree.settings.get' }
  | { type: 'worktree.settings.set'; autoCleanupEnabled?: boolean; cleanupAfterDays?: number }
  | { type: 'worktree.remove'; worktreeId: string }
  | { type: 'thread.relay'; sourceThreadId: string; targetThreadId: string; instruction?: string }
  | { type: 'thread.bus.get'; threadId?: string }
  | { type: 'thread.bus.policy'; policy: import('./thread-bus').CollaborationPolicy; threadId?: string }
  | { type: 'thread.bus.clear-failures'; threadId?: string }
