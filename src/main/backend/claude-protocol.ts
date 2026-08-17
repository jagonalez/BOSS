export type ClaudePermissionMode = 'manual' | 'auto' | 'acceptEdits' | 'plan'
export type BossClaudeMode = 'ask' | 'auto' | 'plan' | 'accept-edits' | undefined

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

/** What Claude Code is sent as the content of a user message.
 *
 *  A string for text alone, and a block array when an image is attached —
 *  Claude Code accepts the same image block the Anthropic API does over its
 *  stream-json input. Flattening every part to text described the picture
 *  instead of sending it: the model was told "[Attached file: shot.png]" and
 *  answered as if it had seen nothing. */
export function claudeMessageContent(parts: unknown[]): string | Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = []
  const text: string[] = []
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue
    const item = part as { type?: string; text?: string; filename?: string; mime?: string; url?: string }
    if (item.type === 'text' && item.text) {
      text.push(item.text)
    } else if (item.type === 'file' && item.mime?.startsWith('image/') && item.url) {
      const data = item.url.match(/^data:[^;]+;base64,(.+)$/)?.[1]
      if (data) blocks.push({ type: 'image', source: { type: 'base64', media_type: item.mime, data } })
      // A file: or http: url is not something Claude Code can read from here,
      // so it stays named rather than silently dropped.
      else text.push(`[Attached file: ${item.filename ?? item.mime}]`)
    } else if (item.type === 'file') {
      text.push(`[Attached file: ${item.filename ?? item.mime ?? 'file'}]`)
    } else if (item.text) {
      text.push(item.text)
    }
  }
  const prompt = text.join('\n')
  if (!blocks.length) return prompt
  // Text last: the instruction reads better after what it refers to.
  return prompt ? [...blocks, { type: 'text', text: prompt }] : blocks
}

/** Report a failed Claude result unless BOSS deliberately stopped the turn.
 *
 * Claude may write a non-success result while handling SIGINT. That is the
 * expected end of Stop & redirect, not a failed turn worth showing to the
 * user. Every other non-success result remains an error. */
export function claudeResultError(value: Record<string, unknown>, intentionallyStopped = false): string | undefined {
  if (value.type !== 'result' || value.subtype === 'success' || intentionallyStopped) return undefined
  return String(value.error ?? value.result ?? 'Claude Code failed.')
}

/** A non-zero process exit is only an error when BOSS did not request it. */
export function claudeExitError(code: number | null, stderr: string, intentionallyStopped = false): string | undefined {
  if (intentionallyStopped || !code) return undefined
  return stderr.trim() || `Claude Code exited with ${code}.`
}

/** The id a streamed part keeps once the finished message replaces it.
 *
 *  A live text or thinking part is published under a fixed id as the deltas
 *  arrive, so the completed message has to use the same id for the block it was
 *  projecting — otherwise the final event adds a second copy beside the live
 *  one. Only the first block of each kind can be matched this way: the deltas
 *  carry no index, so a second thinking block is indistinguishable from more of
 *  the first. */
export function claudeStreamedPartId(
  messageId: string,
  type: string,
  index: number,
  firstTextIndex: number,
  firstThinkingIndex: number
): string {
  if (type === 'text' && index === firstTextIndex) return `${messageId}-text`
  if (type === 'thinking' && index === firstThinkingIndex) return `${messageId}-thinking`
  return `${messageId}-${type}-${index}`
}

export function claudePermissionMode(mode?: BossClaudeMode): ClaudePermissionMode {
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

/** The tool Claude calls to put a question to the user.
 *
 *  It arrives as an ordinary permission request, so without this it was shown
 *  as "allow this tool?" and denying it told Claude the question had been
 *  dismissed — an answer the user never gave and never saw asked for. */
export const ASK_USER_TOOL = 'AskUserQuestion'

export interface ClaudeQuestionOption {
  label: string
  description?: string
}

export interface ClaudeQuestion {
  question: string
  header?: string
  options: ClaudeQuestionOption[]
  multiple: boolean
}

/** Read the questions out of an AskUserQuestion request.
 *
 *  Returns nothing for any other tool, and for a malformed request: a question
 *  with no text is not worth interrupting someone with, and the caller falls
 *  back to the ordinary permission prompt. */
export function parseClaudeQuestions(request: ClaudePermissionRequest): ClaudeQuestion[] | undefined {
  if (request.toolName !== ASK_USER_TOOL) return undefined
  const raw = request.input.questions
  if (!Array.isArray(raw)) return undefined
  const questions = raw.flatMap((entry): ClaudeQuestion[] => {
    if (!entry || typeof entry !== 'object') return []
    const item = entry as Record<string, unknown>
    const question = typeof item.question === 'string' ? item.question.trim() : ''
    if (!question) return []
    const options = Array.isArray(item.options)
      ? item.options.flatMap((option): ClaudeQuestionOption[] => {
        if (typeof option === 'string') return option.trim() ? [{ label: option.trim() }] : []
        if (!option || typeof option !== 'object') return []
        const value = option as Record<string, unknown>
        const label = typeof value.label === 'string' ? value.label.trim() : ''
        return label ? [{ label, description: typeof value.description === 'string' ? value.description : undefined }] : []
      })
      : []
    return [{
      question,
      header: typeof item.header === 'string' ? item.header : undefined,
      options,
      multiple: item.multiSelect === true
    }]
  })
  return questions.length ? questions : undefined
}

/** Give Claude the user's answers, as the result of the tool it called. */
export function claudeQuestionResponse(requestId: string, answers: string[][]): Record<string, unknown> {
  return {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: {
        behavior: 'allow',
        // Claude reads the tool result, so the answers go back as the input it
        // will see rather than as a permission decision.
        updatedInput: { questions: answers.map((choices) => ({ answers: choices })) }
      }
    }
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
