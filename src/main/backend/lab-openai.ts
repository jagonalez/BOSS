import type { MessageWithParts } from '@shared/opencode'
import type { StreamedToolCallDelta } from './lab-tool-call'

/** A message in OpenAI chat-completion shape. Lab only speaks this protocol
 *  (via /v1/chat/completions), which is what makes a cloud OpenAI-compatible
 *  endpoint a drop-in for a local ollama.
 *
 *  This module holds only pure parsing/mapping logic — no I/O, no runtime
 *  imports of other Lab modules — so the test runner can import it directly. */
export interface LabChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  name?: string
  tool_call_id?: string
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
}

interface ChatChoiceDelta {
  content?: string | null
  /** Reasoning summaries, streamed under either name depending on the
   *  provider: DeepSeek-style endpoints send `reasoning_content`, others
   *  `reasoning`. Dropped today means minutes of silent "Thinking" while the
   *  model streams its chain of thought. */
  reasoning_content?: string | null
  reasoning?: string | null
  tool_calls?: Array<{
    index: number
    id?: string | null
    function?: { name?: string | null; arguments?: string | null }
  }>
}

export interface LabChatChunk {
  choices?: Array<{
    delta?: ChatChoiceDelta
    message?: ChatChoiceDelta & { role?: string }
    finish_reason?: string | null
  }>
}

export interface ParsedChatChunk {
  text?: string
  reasoning?: string
  toolCalls?: StreamedToolCallDelta[]
  finishReason?: string
}

/** Pull text and tool-call deltas out of one streamed chunk. Handles both the
 *  streaming `delta` shape and a non-streaming `message` fallback for servers
 *  that ignore `stream: true`. Returns undefined for non-chunk JSON. */
export function parseChatChunk(json: string): ParsedChatChunk | undefined {
  let chunk: LabChatChunk
  try {
    chunk = JSON.parse(json) as LabChatChunk
  } catch {
    return undefined
  }
  const choice = chunk.choices?.[0]
  if (!choice) return undefined
  const delta = choice.delta ?? choice.message
  let text: string | undefined
  if (typeof delta?.content === 'string') text = delta.content
  const rawReasoning = delta?.reasoning_content ?? delta?.reasoning
  const reasoning = typeof rawReasoning === 'string' && rawReasoning ? rawReasoning : undefined
  let toolCalls: StreamedToolCallDelta[] | undefined
  if (delta?.tool_calls) {
    // Some providers (DeepSeek via OpenCode Zen among them) send the id and
    // name only in the first chunk of a call, then an explicit `null` for both
    // in every later chunk of the same index. `null` there means "unchanged",
    // not "cleared", so it must be dropped rather than forwarded — forwarding
    // it overwrites the real name and the call becomes unexecutable.
    toolCalls = delta.tool_calls.map((call) => ({
      index: call.index ?? 0,
      ...(call.id != null ? { id: call.id } : {}),
      ...(call.function?.name != null ? { name: call.function.name } : {}),
      ...(call.function?.arguments != null ? { arguments: call.function.arguments } : {})
    }))
  } else if (delta && 'function_call' in delta) {
    // Some OpenAI-compatible proxies still stream the legacy function_call
    // shape instead of tool_calls.
    const legacy = (delta as { function_call?: { name?: string; arguments?: string } }).function_call
    if (legacy) {
      toolCalls = [{
        index: 0,
        ...(legacy.name !== undefined ? { name: legacy.name } : {}),
        ...(legacy.arguments !== undefined ? { arguments: legacy.arguments } : {})
      }]
    }
  }
  return {
    ...(text !== undefined ? { text } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
    ...(choice.finish_reason ? { finishReason: choice.finish_reason } : {})
  }
}

function textOf(part: { type: string; text?: string }): string {
  return part.type === 'text' ? (part.text ?? '') : ''
}

function argumentText(input: unknown): string {
  if (typeof input === 'string') return input
  try {
    return JSON.stringify(input ?? {})
  } catch {
    return '{}'
  }
}

/** Reassemble the OpenAI request history from Lab's stored parts. Tool parts
 *  carry both the call and its result, so each becomes an assistant tool_call
 *  plus the matching role=tool turn, exactly as the model expects on the next
 *  round. */
export function openAiMessagesFromHistory(
  history: MessageWithParts[],
  systemPrompt: string
): LabChatMessage[] {
  const messages: LabChatMessage[] = [{ role: 'system', content: systemPrompt }]
  for (const message of history) {
    if (message.info.role === 'user') {
      const content = message.parts
        .map((part) => {
          if (part.type === 'file') return `[Attached file: ${part.state?.name ?? part.state?.path ?? 'file'}]`
          return textOf(part)
        })
        .filter(Boolean)
        .join('\n')
      if (content.trim()) messages.push({ role: 'user', content })
      continue
    }
    const text = message.parts.filter((part) => part.type === 'text').map((part) => part.text ?? '').filter(Boolean).join('\n')
    const toolParts = message.parts.filter((part) => part.type === 'tool')
    if (toolParts.length === 0) {
      if (text.trim()) messages.push({ role: 'assistant', content: text })
      continue
    }
    messages.push({
      role: 'assistant',
      content: text.trim() ? text : null,
      tool_calls: toolParts.map((part) => ({
        id: part.id,
        type: 'function',
        function: {
          name: String(part.state?.tool ?? ''),
          arguments: argumentText(part.state?.input)
        }
      }))
    })
    for (const part of toolParts) {
      messages.push({
        role: 'tool',
        tool_call_id: part.id,
        content: typeof part.state?.output === 'string' ? part.state.output : String(part.state?.output ?? '')
      })
    }
  }
  return messages
}

function messageSize(message: MessageWithParts): number {
  let size = 48 // per-message overhead
  for (const part of message.parts) {
    size += part.text?.length ?? 0
    if (part.type !== 'tool' || !part.state) continue
    const output = part.state.output
    size += typeof output === 'string' ? output.length : JSON.stringify(output ?? '').length
    const input = part.state.input
    size += typeof input === 'string' ? input.length : JSON.stringify(input ?? {}).length
  }
  return size
}

/** Keep a thread's history inside a context budget so long sessions do not
 *  overflow the model's window.
 *
 *  Trimming takes the newest messages and the original user instruction.
 *  Each message is kept whole — tool calls and their results live in the same
 *  assistant message, so an assistant tool_call is never separated from the
 *  result that answers it. Returns `omitted` so the caller can tell the model
 *  it is working from a shortened transcript. */
export function cropHistory(
  history: MessageWithParts[],
  maxChars: number
): { history: MessageWithParts[]; omitted: boolean } {
  const total = history.reduce((sum, message) => sum + messageSize(message), 0)
  if (total <= maxChars) return { history, omitted: false }

  const firstUser = history.find((message) => message.info.role === 'user')
  const kept: MessageWithParts[] = []
  let used = 0
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index]
    const size = messageSize(message)
    if (kept.length > 0 && used + size > maxChars) continue
    kept.push(message)
    used += size
  }
  kept.reverse()
  if (firstUser && !kept.some((message) => message.info.id === firstUser.info.id)) {
    kept.unshift(firstUser)
  }
  return { history: kept, omitted: true }
}