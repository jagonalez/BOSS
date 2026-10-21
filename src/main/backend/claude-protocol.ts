import type { MessageWithParts, Part } from '@shared/opencode'
// @ts-expect-error Node's type-stripping test runner needs the extension.
import { toolLabel } from '../../shared/tool-label.ts'

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

/** The user's durable transcript copy. Claude's SDK history is owned by BOSS,
 *  so the echo must retain the original file part as well as the text sent to
 *  the model. Keeping only text made the model see a screenshot that the user
 *  could no longer see in their own conversation. */
export function claudeTranscriptParts(parts: unknown[], sessionID: string, messageID: string): Part[] {
  const transcript: Part[] = []
  for (const [index, part] of parts.entries()) {
    if (!part || typeof part !== 'object') continue
    const item = part as { type?: string; text?: string; filename?: string; mime?: string; url?: string }
    if (item.type === 'text' && item.text) {
      transcript.push({ id: `${messageID}-text-${index}`, type: 'text', sessionID, messageID, text: item.text })
    } else if (item.type === 'file') {
      transcript.push({
        id: `${messageID}-file-${index}`,
        type: 'file',
        sessionID,
        messageID,
        state: {
          status: 'completed',
          path: item.filename,
          name: item.filename,
          ...(item.mime?.startsWith('image/') && item.url ? { mime: item.mime, url: item.url } : {})
        }
      })
    }
  }
  return transcript
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

/** The BOSS parts for the content of one assistant message from Claude.
 *
 *  Used for the live stream and for an imported transcript alike, so a message
 *  read back from Claude Code's own file has the ids the stream would have
 *  given it. */
export function claudeContentParts(sessionId: string, messageId: string, content: unknown): Part[] {
  if (!Array.isArray(content)) return []
  const firstTextIndex = content.findIndex((block) => (
    Boolean(block) && typeof block === 'object' && (block as { type?: string }).type === 'text'
  ))
  const firstThinkingIndex = content.findIndex((block) => (
    Boolean(block) && typeof block === 'object' && (block as { type?: string }).type === 'thinking'
  ))
  return content.flatMap<Part>((block, index): Part[] => {
    if (!block || typeof block !== 'object') return []
    const item = block as Record<string, unknown>
    if (item.type === 'text' || item.type === 'thinking') {
      return [{
        id: claudeStreamedPartId(messageId, String(item.type), index, firstTextIndex, firstThinkingIndex),
        type: item.type === 'thinking' ? 'reasoning' as const : 'text' as const,
        sessionID: sessionId,
        messageID: messageId,
        text: String(item.text ?? item.thinking ?? '')
      }]
    }
    if (item.type === 'tool_use') {
      return [{
        id: String(item.id ?? `${messageId}-tool-${index}`),
        type: 'tool' as const,
        sessionID: sessionId,
        messageID: messageId,
        state: {
          status: 'running' as const,
          tool: String(item.name ?? 'tool'),
          // Without a title the transcript heads every call with the tool's name, so a run of
          // shell calls reads as "Bash" fifteen times. Codex already names its own this way.
          title: toolLabel(String(item.name ?? ''), item.input),
          input: item.input
        }
      }]
    }
    if (item.type === 'tool_result') {
      return [{
        id: String(item.tool_use_id ?? `${messageId}-result-${index}`),
        type: 'tool' as const,
        sessionID: sessionId,
        messageID: messageId,
        state: { status: item.is_error ? 'error' as const : 'completed' as const, output: item.content }
      }]
    }
    return []
  })
}

/** One line of a Claude Code transcript, as the Agent SDK's
 *  getSessionMessages returns it. `timestamp` is on every line Claude Code
 *  writes but missing from the SDK's type. */
export interface ClaudeHistoryEntry {
  type: 'user' | 'assistant' | 'system'
  uuid: string
  message: unknown
  parent_tool_use_id: string | null
  timestamp?: string
}

function isToolResult(block: unknown): boolean {
  return Boolean(block) && typeof block === 'object' && (block as { type?: string }).type === 'tool_result'
}

/** What the user wrote, as BOSS parts. Ids follow claudeTranscriptParts, so a
 *  message BOSS sent reads back with the parts it was recorded with. */
function claudeUserParts(sessionId: string, messageId: string, content: unknown): Part[] {
  if (typeof content === 'string') {
    return content.trim() ? [{ id: `${messageId}-text-0`, type: 'text', sessionID: sessionId, messageID: messageId, text: content }] : []
  }
  if (!Array.isArray(content)) return []
  return content.flatMap<Part>((block, index): Part[] => {
    if (!block || typeof block !== 'object') return []
    const item = block as { type?: string; text?: string; source?: { type?: string; media_type?: string; data?: string } }
    if (item.type === 'text' && item.text?.trim()) {
      return [{ id: `${messageId}-text-${index}`, type: 'text', sessionID: sessionId, messageID: messageId, text: item.text }]
    }
    if (item.type === 'image' && item.source?.type === 'base64' && item.source.media_type && item.source.data) {
      return [{
        id: `${messageId}-file-${index}`,
        type: 'file',
        sessionID: sessionId,
        messageID: messageId,
        state: {
          status: 'completed',
          name: 'Image',
          mime: item.source.media_type,
          url: `data:${item.source.media_type};base64,${item.source.data}`
        }
      }]
    }
    return []
  })
}

/** The content blocks of each assistant reply, joined across the lines
 *  Claude Code writes it on.
 *
 *  Claude Code puts every block of a reply on its own line under the reply's
 *  id, and the SDK streams the same lines. Mapped one line at a time, the first
 *  text block of every line took the same id, so a reply with two text blocks
 *  kept only the last. The live stream and the importer both join through
 *  this, so a reply gets the same parts either way. A line is keyed by its own
 *  uuid, so one seen twice is not added twice. */
export class ClaudeReplyBlocks {
  private readonly replies = new Map<string, Map<string, unknown[]>>()

  add(messageId: string, lineId: string, content: unknown): unknown[] {
    const lines = this.replies.get(messageId) ?? new Map<string, unknown[]>()
    lines.set(lineId, Array.isArray(content) ? content : [])
    this.replies.set(messageId, lines)
    return [...lines.values()].flat()
  }
}

/** A Claude Code session's history as BOSS messages, for importing a session
 *  the user ran outside BOSS.
 *
 *  The lines of one reply are joined back into one message, the way the live
 *  stream joins them. A tool's result arrives on a later user line and
 *  completes the call it answers; anything else on that line is still the
 *  user's message. Subagent lines are left out: the subagent's report reaches
 *  the conversation as the result of the tool that started it. */
export function claudeHistoryMessages(sessionId: string, entries: ClaudeHistoryEntry[]): MessageWithParts[] {
  const messages: MessageWithParts[] = []
  const assistants = new Map<string, MessageWithParts>()
  const replies = new ClaudeReplyBlocks()
  const tools = new Map<string, MessageWithParts>()
  const results = new Map<string, Pick<NonNullable<Part['state']>, 'status' | 'output'>>()
  const withResult = (part: Part): Part => {
    const result = results.get(part.id)
    return part.type === 'tool' && result ? { ...part, state: { ...part.state, ...result } } : part
  }
  for (const entry of entries) {
    if (entry.parent_tool_use_id) continue
    const inner = (entry.message ?? {}) as { id?: string; content?: unknown; model?: string }
    const parsed = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN
    const created = Number.isFinite(parsed) ? parsed : undefined
    if (entry.type === 'assistant') {
      const id = inner.id ?? entry.uuid
      let message = assistants.get(id)
      if (!message) {
        message = {
          info: {
            id,
            sessionID: sessionId,
            role: 'assistant',
            model: inner.model ? { id: inner.model, provider: 'anthropic' } : undefined,
            time: { created }
          },
          parts: []
        }
        assistants.set(id, message)
        messages.push(message)
      }
      message.parts = claudeContentParts(sessionId, id, replies.add(id, entry.uuid, inner.content)).map(withResult)
      for (const part of message.parts) if (part.type === 'tool') tools.set(part.id, message)
    } else if (entry.type === 'user') {
      if (Array.isArray(inner.content)) {
        for (const block of inner.content) {
          if (!isToolResult(block)) continue
          const result = block as { tool_use_id?: string; content?: unknown; is_error?: boolean }
          if (!result.tool_use_id) continue
          results.set(result.tool_use_id, { status: result.is_error ? 'error' : 'completed', output: result.content })
          const owner = tools.get(result.tool_use_id)
          if (owner) owner.parts = owner.parts.map(withResult)
        }
      }
      const parts = claudeUserParts(sessionId, entry.uuid, inner.content)
      if (parts.length) messages.push({ info: { id: entry.uuid, sessionID: sessionId, role: 'user', time: { created } }, parts })
    }
  }
  return messages
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
