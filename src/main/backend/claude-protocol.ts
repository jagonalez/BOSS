/** The mode names the Claude Agent SDK takes.
 *
 *  'default' is what the SDK types call the mode the CLI spells 'manual' — the
 *  CLI still accepts 'manual' as an alias, so this is a rename rather than a
 *  behaviour change. */
export type ClaudePermissionMode = 'default' | 'auto' | 'acceptEdits' | 'plan'
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
  return 'default'
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

/** Pair each answer with the question it answers, by that question's text.
 *
 *  Position is what BOSS collects and question text is what Claude reads, so
 *  the two are matched by index here. A question with no answer is left out
 *  rather than sent as an empty string, which would read as a real choice.
 *  Several selections join with a comma: the field holds one string per
 *  question, not a list. */
export function claudeQuestionAnswers(questions: unknown[], answers: string[][]): Record<string, string> {
  const paired: Record<string, string> = {}
  questions.forEach((entry, index) => {
    const text = entry && typeof entry === 'object' ? (entry as { question?: unknown }).question : undefined
    const choices = answers[index]
    if (typeof text !== 'string' || !text || !choices?.length) return
    paired[text] = choices.join(', ')
  })
  return paired
}

/** The tool input Claude should see once the user has answered.
 *
 *  Claude Code validates this against the AskUserQuestion schema, which still
 *  requires every question to carry its question, header, and options. So the
 *  questions travel back exactly as they arrived and the answers ride beside
 *  them, keyed by question text. Replacing the array with bare answer objects
 *  failed that check, and the user's choice was reported to the model as a
 *  configuration error instead of an answer.
 *
 *  Returns the input alone rather than a control_response envelope: the SDK
 *  wraps it in the allow decision that canUseTool returns. */
export function claudeQuestionInput(
  pending: Pick<ClaudePermissionRequest, 'input'>,
  answers: string[][]
): Record<string, unknown> {
  const questions = Array.isArray(pending.input.questions) ? pending.input.questions : []
  return { ...pending.input, questions, answers: claudeQuestionAnswers(questions, answers) }
}

/** What canUseTool returns for the user's decision.
 *
 *  The SDK awaits a PermissionResult rather than taking a control_response, so
 *  this is the decision alone. "always" carries the SDK's own permission
 *  suggestions back as updatedPermissions, which is what stops Claude asking
 *  again for the same tool this session. */
export function claudePermissionDecision(
  pending: Pick<ClaudePermissionRequest, 'input' | 'suggestions'>,
  response: 'once' | 'always' | 'reject'
): { behavior: 'allow'; updatedInput: Record<string, unknown>; updatedPermissions?: unknown[] } | { behavior: 'deny'; message: string; interrupt: boolean } {
  if (response === 'reject') {
    return { behavior: 'deny', message: 'The user denied this tool request.', interrupt: false }
  }
  return {
    behavior: 'allow',
    updatedInput: pending.input,
    ...(response === 'always' && pending.suggestions.length > 0 ? { updatedPermissions: pending.suggestions } : {})
  }
}
