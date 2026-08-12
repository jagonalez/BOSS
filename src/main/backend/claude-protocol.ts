export type ClaudePermissionMode = 'manual' | 'auto' | 'acceptEdits' | 'plan'
export type RalfClaudeMode = 'ask' | 'auto' | 'plan' | 'accept-edits' | undefined

export interface ClaudePermissionRequest {
  requestId: string
  toolName: string
  input: Record<string, unknown>
  suggestions: unknown[]
  title?: string
  description?: string
  displayName?: string
  toolUseId?: string
}

export function claudePermissionMode(mode?: RalfClaudeMode): ClaudePermissionMode {
  if (mode === 'plan') return 'plan'
  if (mode === 'auto') return 'auto'
  if (mode === 'accept-edits') return 'acceptEdits'
  return 'manual'
}

export function parseClaudePermission(value: Record<string, unknown>): ClaudePermissionRequest | undefined {
  if (value.type !== 'control_request') return undefined
  const requestId = typeof value.request_id === 'string' ? value.request_id : ''
  const request = value.request as Record<string, unknown> | undefined
  if (!requestId || request?.subtype !== 'can_use_tool') return undefined
  return {
    requestId,
    toolName: String(request.tool_name ?? 'tool'),
    input: request.input && typeof request.input === 'object' ? request.input as Record<string, unknown> : {},
    suggestions: Array.isArray(request.permission_suggestions) ? request.permission_suggestions : [],
    title: typeof request.title === 'string' ? request.title : undefined,
    description: typeof request.description === 'string' ? request.description : undefined,
    displayName: typeof request.display_name === 'string' ? request.display_name : undefined,
    toolUseId: typeof request.tool_use_id === 'string' ? request.tool_use_id : undefined
  }
}

export function claudePermissionResponse(
  requestId: string,
  pending: Pick<ClaudePermissionRequest, 'input' | 'suggestions'>,
  response: 'once' | 'always' | 'reject'
): Record<string, unknown> {
  const decision = response === 'reject'
    ? { behavior: 'deny', message: 'The user denied this tool request.', interrupt: false }
    : {
        behavior: 'allow',
        updatedInput: pending.input,
        ...(response === 'always' && pending.suggestions.length > 0 ? { updatedPermissions: pending.suggestions } : {})
      }
  return {
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response: decision }
  }
}

