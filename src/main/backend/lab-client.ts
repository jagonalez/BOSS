// The explicit extensions keep this module executable under Node's type-stripping test runner.
// @ts-expect-error Application builds use bundler resolution.
import { SseDecoder } from './lab-sse.ts'
// @ts-expect-error Application builds use bundler resolution.
import { ToolCallAccumulator, type LabFunctionCall, type StreamedToolCallDelta } from './lab-tool-call.ts'
// @ts-expect-error Application builds use bundler resolution.
import { parseChatChunk, type LabChatMessage, type LabReasoningDetail } from './lab-openai.ts'
import type { LabToolFunction } from './lab-tools'

/** HTTP for Lab: a streaming OpenAI-compatible client built only on fetch and
 *  the SSE parser. Kept out of lab-openai.ts so that module stays pure and
 *  directly testable; this file is imported only by the backend itself. */

/** Tolerate both streaming shapes some endpoints emit:
 *  - spec deltas: each chunk is only the newly generated text
 *  - cumulative snapshots: each chunk resends the whole message so far
 *    (several local servers do this)
 *
 *  The mode is decided from the first two text chunks. In cumulative mode the
 *  new text is extracted by length, which self-heals after any one-off prefix
 *  mismatch (e.g. a stray leading-space chunk) instead of doubling forever. */
export class StreamText {
  private full = ''
  private mode: 'delta' | 'cumulative' | undefined
  private first: string | undefined

  push(text: string): string {
    if (this.mode === 'cumulative') {
      const delta = text.length > this.full.length ? text.slice(this.full.length) : ''
      this.full = text.length > this.full.length ? text : this.full
      return delta
    }
    if (this.mode === 'delta') {
      this.full += text
      return text
    }
    // Mode not yet known. Ignore leading whitespace-only noise so it cannot
    // poison the prefix used to detect a cumulative server.
    if (text.trim() === '') return ''
    if (this.first === undefined) {
      this.first = text
      this.full = text
      return text
    }
    this.mode = text.length > this.first.length && text.startsWith(this.first) ? 'cumulative' : 'delta'
    if (this.mode === 'cumulative') {
      const delta = text.slice(this.first.length)
      this.full = text
      return delta
    }
    this.full += text
    return text
  }

  get value(): string {
    return this.full
  }
}

export interface SplitReasoningDelta {
  text?: string
  reasoning?: string
}

/** Split the raw leading `<think>...</think>` convention used by some local
 *  and frontier-compatible endpoints. It waits only while the opening or
 *  closing tag is ambiguous, so tags may be divided across SSE chunks without
 *  leaking into the answer. Tags later in ordinary prose/code stay literal. */
export class ReasoningTagSplitter {
  private mode: 'prefix' | 'reasoning' | 'text' = 'prefix'
  private buffer = ''
  private closingTag = ''

  push(delta: string): SplitReasoningDelta {
    if (!delta) return {}
    if (this.mode === 'text') return { text: delta }
    this.buffer += delta
    if (this.mode === 'reasoning') return this.drainReasoning()

    const leading = this.buffer.match(/^\s*/)?.[0] ?? ''
    const candidate = this.buffer.slice(leading.length)
    const lower = candidate.toLowerCase()
    const openings = [
      { open: '<think>', close: '</think>' },
      { open: '<thinking>', close: '</thinking>' }
    ]
    const matched = openings.find(({ open }) => lower.startsWith(open))
    if (matched) {
      this.mode = 'reasoning'
      this.closingTag = matched.close
      this.buffer = candidate.slice(matched.open.length)
      return this.drainReasoning()
    }
    if (openings.some(({ open }) => open.startsWith(lower))) return {}

    this.mode = 'text'
    const text = this.buffer
    this.buffer = ''
    return { text }
  }

  flush(): SplitReasoningDelta {
    if (!this.buffer) return {}
    const value = this.buffer
    this.buffer = ''
    return this.mode === 'reasoning' ? { reasoning: value } : { text: value }
  }

  private drainReasoning(): SplitReasoningDelta {
    const lower = this.buffer.toLowerCase()
    const closeAt = lower.indexOf(this.closingTag)
    if (closeAt >= 0) {
      const reasoning = this.buffer.slice(0, closeAt)
      const text = this.buffer.slice(closeAt + this.closingTag.length)
      this.buffer = ''
      this.mode = 'text'
      return {
        ...(reasoning ? { reasoning } : {}),
        ...(text ? { text } : {})
      }
    }

    // Retain the longest suffix that could still become the closing tag when
    // the next SSE chunk arrives; the rest is known reasoning and can stream.
    let retained = 0
    const max = Math.min(this.buffer.length, this.closingTag.length - 1)
    for (let length = max; length > 0; length--) {
      if (this.closingTag.startsWith(lower.slice(-length))) {
        retained = length
        break
      }
    }
    const end = this.buffer.length - retained
    const reasoning = this.buffer.slice(0, end)
    this.buffer = this.buffer.slice(end)
    return reasoning ? { reasoning } : {}
  }
}

export interface ChatStreamResult {
  content: string
  /** Reasoning text streamed alongside the answer, under either provider
   *  field name. Empty when the model did not reason. */
  reasoning: string
  /** Structured provider reasoning blocks, preserved byte-for-byte at the
   *  JSON value level for the assistant's next tool-result turn. */
  reasoningDetails: LabReasoningDetail[]
  toolCalls: LabFunctionCall[]
  finishReason?: string
}

export interface ChatStreamOptions {
  baseUrl: string
  model: string
  messages: LabChatMessage[]
  tools?: LabToolFunction[]
  apiKey?: string
  signal?: AbortSignal
  /** Hard ceiling on one request, so a stalled server cannot hang the thread
   *  forever. Combined with `signal` if both are given. */
  timeoutMs?: number
  onText?: (delta: string) => void
  onReasoning?: (delta: string) => void
  onToolCallDelta?: (delta: StreamedToolCallDelta) => void
  onFinishReason?: (reason: string) => void
}

const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60_000

/** Post a streaming chat completion and fold the SSE payload into text and
 *  tool-call results. */
export async function streamChatCompletion(options: ChatStreamOptions): Promise<ChatStreamResult> {
  const body: Record<string, unknown> = {
    model: options.model,
    messages: options.messages,
    stream: true
  }
  if (options.tools && options.tools.length > 0) body.tools = options.tools

  const timeout = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout)])
    : AbortSignal.timeout(timeout)

  const response = await fetch(`${options.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {})
    },
    body: JSON.stringify(body),
    signal
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Chat completion failed (${response.status}): ${detail.slice(0, 300)}`)
  }
  if (!response.body) throw new Error('Chat completion returned an empty body.')

  const decoder = new SseDecoder()
  const textDecoder = new TextDecoder()
  const reader = response.body.getReader()
  const accumulator = new ToolCallAccumulator()
  const textTracker = new StreamText()
  const reasoningSplitter = new ReasoningTagSplitter()
  let content = ''
  let reasoning = ''
  const reasoningDetails: LabReasoningDetail[] = []
  let finishReason: string | undefined

  const emitSplit = (split: SplitReasoningDelta): void => {
    if (split.reasoning) {
      reasoning += split.reasoning
      options.onReasoning?.(split.reasoning)
    }
    if (split.text) {
      content += split.text
      options.onText?.(split.text)
    }
  }

  const finish = (): ChatStreamResult => {
    emitSplit(reasoningSplitter.flush())
    return {
      content,
      reasoning,
      reasoningDetails,
      toolCalls: accumulator.calls(),
      ...(finishReason ? { finishReason } : {})
    }
  }

  const handleData = (data: string): void => {
    const parsed = parseChatChunk(data)
    if (!parsed) return
    if (parsed.reasoning) {
      reasoning += parsed.reasoning
      options.onReasoning?.(parsed.reasoning)
    }
    if (parsed.reasoningDetails) {
      reasoningDetails.push(...parsed.reasoningDetails)
      // A provider can supply both a compatibility reasoning string and its
      // structured source. Only display one copy, but always preserve blocks.
      if (!parsed.reasoning) {
        const detailText = parsed.reasoningDetails
          .map((detail) => typeof detail.text === 'string' ? detail.text : typeof detail.summary === 'string' ? detail.summary : '')
          .join('')
        if (detailText) {
          reasoning += detailText
          options.onReasoning?.(detailText)
        }
      }
    }
    if (parsed.text) {
      const delta = textTracker.push(parsed.text)
      emitSplit(reasoningSplitter.push(delta))
    }
    for (const delta of parsed.toolCalls ?? []) {
      accumulator.push(delta)
      options.onToolCallDelta?.(delta)
    }
    if (parsed.finishReason) {
      finishReason = parsed.finishReason
      options.onFinishReason?.(parsed.finishReason)
    }
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const text = textDecoder.decode(value, { stream: true })
    for (const event of decoder.push(text)) {
      if (event.type === 'done') return finish()
      handleData(event.data)
    }
  }
  await reader.cancel?.()
  for (const event of decoder.flush()) {
    if (event.type === 'data') handleData(event.data)
  }
  return finish()
}

/** Adapt an LLM server's model catalogue into BOSS model entries. Tries
 *  ollama's GET /api/tags first, then the OpenAI-compatible GET /v1/models. */
export async function listModels(
  baseUrl: string,
  apiKey?: string
): Promise<Array<{ id: string; name?: string; provider?: string; source?: 'local' | 'cloud' }>> {
  const host = baseUrl.replace(/\/v1\/?$/, '')
  const requestOptions: { method: string; headers?: Record<string, string>; signal: AbortSignal } = {
    method: 'GET',
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
    signal: AbortSignal.timeout(5_000)
  }
  try {
    const response = await fetch(`${host}/api/tags`, requestOptions)
    if (response.ok) {
      const body = (await response.json()) as { models?: Array<{ name: string }> }
      return (body.models ?? []).map((model) => ({
        id: model.name,
        name: model.name,
        provider: 'ollama',
        source: 'local'
      }))
    }
  } catch {
    /* fall through to the OpenAI-compatible endpoint */
  }
  try {
    const response = await fetch(`${baseUrl}/models`, requestOptions)
    if (response.ok) {
      const body = (await response.json()) as { data?: Array<{ id: string; name?: string }> }
      return (body.data ?? []).map((model) => ({
        id: model.id,
        name: model.name ?? model.id,
        provider: 'openai',
        source: 'cloud'
      }))
    }
  } catch {
    /* server unreachable */
  }
  return []
}
