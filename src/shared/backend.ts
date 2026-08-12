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
  steering: 'native' | 'stop-and-redirect'
  branching: 'message' | 'thread' | 'context-copy'
  images: boolean
  mcp: boolean
  interactiveQuestions: boolean
}

export interface QueuedFollowUpAttachment {
  id: string
  name: string
  mime: string
  dataUrl: string
}

export interface QueuedFollowUp {
  id: string
  threadId: string
  text: string
  attachments: QueuedFollowUpAttachment[]
  options?: BackendMessageOptions
  createdAt: number
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

export interface BackendAuthStatus {
  backendId: BackendId
  state: 'connected' | 'not-connected' | 'unknown'
  detail: string
  accounts?: string[]
}

export interface BackendModelDescriptor {
  id: string
  name?: string
  provider?: string
  variants?: string[]
  source?: 'local' | 'cloud' | 'custom'
}

export interface BackendModelPreference {
  modelID: string
  providerID: string
}

export interface BackendMessageOptions {
  model?: { providerID: string; modelID: string; variant?: string }
  agent?: string
  mode?: BackendModeId
}

export type BackendRequest =
  | { type: 'backend.list' }
  | { type: 'backend.auth.status' }
  | { type: 'thread.list' }
  | { type: 'thread.create'; backendId: BackendId; title?: string; scope?: ThreadCreationScope }
  | { type: 'thread.get'; threadId: string }
  | { type: 'thread.delete'; threadId: string }
  | { type: 'thread.rename'; threadId: string; title: string }
  | { type: 'thread.messages'; threadId: string; limit?: number }
  | { type: 'thread.send'; threadId: string; parts: unknown[]; options?: BackendMessageOptions }
  | { type: 'thread.followups.list'; threadId: string }
  | { type: 'thread.followups.add'; threadId: string; text: string; attachments?: QueuedFollowUpAttachment[]; options?: BackendMessageOptions }
  | { type: 'thread.followups.update'; threadId: string; followUpId: string; text: string }
  | { type: 'thread.followups.remove'; threadId: string; followUpId: string }
  | { type: 'thread.followups.move'; threadId: string; followUpId: string; toIndex: number }
  | { type: 'thread.followups.steer'; threadId: string; followUpId: string }
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
  | { type: 'thread.clone'; threadId: string; backendId: BackendId; instruction?: string; options?: BackendMessageOptions }
  | { type: 'thread.worktree.create'; threadId: string; messageId?: string; instruction?: string; options?: BackendMessageOptions }
  | { type: 'worktree.list'; threadId?: string }
  | { type: 'worktree.settings.get' }
  | { type: 'worktree.settings.set'; autoCleanupEnabled?: boolean; cleanupAfterDays?: number }
  | { type: 'worktree.remove'; worktreeId: string }
  | { type: 'thread.relay'; sourceThreadId: string; targetThreadId: string; instruction?: string }
  | { type: 'automation.list' }
  | { type: 'automation.create'; input: import('./automation').AutomationInput }
  | { type: 'automation.update'; automationId: string; patch: Partial<import('./automation').AutomationInput> & { enabled?: boolean } }
  | { type: 'automation.delete'; automationId: string }
  | { type: 'automation.run'; automationId: string }
  | { type: 'automation.stop'; automationId: string }
  | { type: 'mcp.list' }
  | { type: 'mcp.add'; input: import('./mcp').McpConnectionInput }
  | { type: 'mcp.update'; connectionId: string; patch: Partial<import('./mcp').McpConnectionInput> & { enabled?: boolean } }
  | { type: 'mcp.remove'; connectionId: string }
  | { type: 'mcp.import.scan' }
  | { type: 'thread.bus.get'; threadId?: string }
  | { type: 'thread.bus.policy'; policy: import('./thread-bus').CollaborationPolicy; threadId?: string }
  | { type: 'thread.bus.clear-failures'; threadId?: string }
  | { type: 'thread.qa.get'; threadId: string }
  | { type: 'thread.qa.policy'; threadId: string; policy: import('./qa').QaPolicy | null }
  | { type: 'qa.default.get' }
  | { type: 'qa.default.policy'; policy: import('./qa').QaPolicy }
