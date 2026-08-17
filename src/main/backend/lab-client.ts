// The explicit extensions keep this module executable under Node's type-stripping test runner.
// @ts-expect-error Application builds use bundler resolution.
import { SseDecoder } from './lab-sse.ts'
// @ts-expect-error Application builds use bundler resolution.
import { ToolCallAccumulator, type LabFunctionCall, type StreamedToolCallDelta } from './lab-tool-call.ts'
// @ts-expect-error Application builds use bundler resolution.
import { parseChatChunk, type LabChatMessage } from './lab-openai.ts'
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

export interface ChatStreamResult {
  content: string
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
  let content = ''

  const handleData = (data: string): void => {
    const parsed = parseChatChunk(data)
    if (!parsed) return
    if (parsed.text) {
      const delta = textTracker.push(parsed.text)
      content += delta
      options.onText?.(delta)
    }
    for (const delta of parsed.toolCalls ?? []) {
      accumulator.push(delta)
      options.onToolCallDelta?.(delta)
    }
    if (parsed.finishReason) options.onFinishReason?.(parsed.finishReason)
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const text = textDecoder.decode(value, { stream: true })
    for (const event of decoder.push(text)) {
      if (event.type === 'done') return { content, toolCalls: accumulator.calls() }
      handleData(event.data)
    }
  }
  await reader.cancel?.()
  for (const event of decoder.flush()) {
    if (event.type === 'data') handleData(event.data)
  }
  return { content, toolCalls: accumulator.calls() }
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