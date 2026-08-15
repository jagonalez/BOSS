export type BackendId = 'opencode' | 'pi' | 'codex' | 'claude'
export type BackendModeId = 'ask' | 'auto' | 'plan' | 'accept-edits'
export type ThreadCreationScope = 'current' | 'global'
export type DelegatePlacement = 'same-checkout' | 'new-worktree'

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
  /** The backend enforces its own Auto policy; escalations must still be shown to the user. */
  nativeAutoMode: boolean
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
  /** Thinking level, when the chosen model offers one. Stored beside the model
   *  rather than per backend because the levels belong to the model: claude's
   *  Sonnet stops at high where Opus goes to max, and codex reads them from
   *  each model's own list. A level saved against one model means nothing to
   *  another. */
  variant?: string
  /** How much the agent may do without asking. Per backend, because the modes
   *  are the backend's own — codex has no accept-edits, pi has one mode. */
  mode?: BackendModeId
}

export interface BackendMessageOptions {
  model?: { providerID: string; modelID: string; variant?: string }
  agent?: string
  mode?: BackendModeId
  /** Headless runs: restrict the agent to BOSS-provided tools, ignoring user-level MCP configs. */
  strictTools?: boolean
  /** Which project and checkout this thread is working in, ready to put in the
   *  system prompt. Without it an agent infers its project from the directory
   *  it happens to be in, and infers the repository from whatever else it can
   *  see — one asked about a browser tab and guessed. */
  context?: string
}

export type BackendRequest =
  | { type: 'backend.list' }
  | { type: 'backend.auth.status' }
  | { type: 'backend.defaults.set'; defaults: Partial<Record<BackendId, BackendModelPreference>> }
  | { type: 'backend.bin.get' }
  /** An empty or omitted path clears the override, returning the backend to PATH. */
  | { type: 'backend.bin.set'; backendId: BackendId; path?: string }
  | { type: 'thread.list' }
  | { type: 'thread.create'; backendId: BackendId; title?: string; scope?: ThreadCreationScope; executionPath?: string }
  | { type: 'thread.backend.set'; threadId: string; backendId: BackendId }
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
  | { type: 'thread.question'; threadId: string; requestId: string; answers: string[][] }
  | { type: 'thread.compact'; threadId: string; model?: { providerID: string; modelID: string } }
  | { type: 'thread.models'; threadId?: string; backendId?: BackendId }
  | { type: 'supervision.snapshot' }
  | { type: 'supervision.search'; query: string; limit?: number }
  | { type: 'supervision.acknowledge'; threadId: string }
  | { type: 'thread.policy.get'; threadId: string }
  | { type: 'thread.policy.set'; threadId: string; policy: import('./task-policy').TaskPolicy }
  | { type: 'thread.clone'; threadId: string; backendId: BackendId; instruction?: string; options?: BackendMessageOptions }
  | { type: 'thread.delegate'; threadId: string; backendId: BackendId; instruction: string; placement: DelegatePlacement; options?: BackendMessageOptions }
  | { type: 'thread.worktree.create'; threadId: string; messageId?: string; instruction?: string; options?: BackendMessageOptions }
  | { type: 'worktree.list'; threadId?: string }
  | { type: 'worktree.settings.get' }
  | { type: 'worktree.settings.set'; autoCleanupEnabled?: boolean; cleanupAfterDays?: number; location?: import('./worktree').WorktreeLocation }
  | { type: 'worktree.remove'; worktreeId: string }
  | { type: 'thread.relay'; sourceThreadId: string; targetThreadId: string; instruction?: string }
  | { type: 'automation.list' }
  | { type: 'automation.create'; input: import('./automation').AutomationInput }
  | { type: 'automation.update'; automationId: string; patch: Partial<import('./automation').AutomationInput> & { enabled?: boolean } }
  | { type: 'automation.delete'; automationId: string }
  | { type: 'automation.run'; automationId: string }
  | { type: 'automation.stop'; automationId: string }
  | { type: 'automation.webhook.get' }
  | { type: 'automation.webhook.set'; url: string }
  | { type: 'mcp.list' }
  | { type: 'mcp.add'; input: import('./mcp').McpConnectionInput }
  | { type: 'mcp.update'; connectionId: string; patch: Partial<import('./mcp').McpConnectionInput> & { enabled?: boolean } }
  | { type: 'mcp.remove'; connectionId: string }
  | { type: 'mcp.import.scan' }
  | { type: 'mobile.status' }
  | { type: 'mobile.set'; patch: { enabled?: boolean; port?: number; tailscale?: boolean; regenerateToken?: boolean; regenerateViewerToken?: boolean } }
  | { type: 'thread.bus.get'; threadId?: string }
  | { type: 'thread.bus.policy'; policy: import('./thread-bus').CollaborationPolicy; threadId?: string }
  | { type: 'thread.bus.clear-failures'; threadId?: string }
  | { type: 'thread.qa.get'; threadId: string }
  | { type: 'thread.qa.policy'; threadId: string; policy: import('./qa').QaPolicy | null }
  | { type: 'qa.default.get' }
  | { type: 'qa.default.policy'; policy: import('./qa').QaPolicy }
