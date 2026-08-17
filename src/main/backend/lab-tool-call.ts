/** Parsing for the tool-calling half of an OpenAI-compatible stream.
 *
 *  In stream mode a single tool call arrives as several chunks: each carries an
 *  index, and `function.arguments` is a fragment of a JSON object that must be
 *  reassembled across chunks and parsed once the stream ends. All of this is
 *  pure string/JSON work, so it lives apart from the backend and is tested
 *  directly. */
export interface StreamedToolCallDelta {
  index: number
  id?: string
  name?: string
  arguments?: string
}

export interface LabFunctionCall {
  id: string
  name: string
  /** The raw JSON-encoded arguments, reassembled from stream fragments. */
  arguments: string
}

interface AccumulatedCall {
  id?: string
  name?: string
  arguments: string
}

export class ToolCallAccumulator {
  private readonly byIndex = new Map<number, AccumulatedCall>()

  push(delta: StreamedToolCallDelta): void {
    const current = this.byIndex.get(delta.index) ?? { arguments: '' }
    if (delta.id !== undefined) current.id = delta.id
    if (delta.name !== undefined) current.name = delta.name
    if (delta.arguments !== undefined) current.arguments += delta.arguments
    this.byIndex.set(delta.index, current)
  }

  /** Reassembled calls in index order. */
  calls(): LabFunctionCall[] {
    return [...this.byIndex.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => ({
        id: call.id ?? '',
        name: call.name ?? '',
        arguments: call.arguments
      }))
  }

  get length(): number {
    return this.byIndex.size
  }
}

/** Parse a reassembled arguments string into an object, tolerating the
 *  truncation small models sometimes produce. Returns an empty object when the
 *  string is blank, and throws a descriptive error when no repair works. */
export function parseToolArguments(raw: string): Record<string, unknown> {
  const trimmed = raw.trim()
  if (!trimmed) return {}
  try {
    const value = JSON.parse(trimmed)
    if (value && typeof value === 'object') return value as Record<string, unknown>
    return {}
  } catch {
    for (const candidate of [trimmed + '}', trimmed + '"]', trimmed + '"}']) {
      try {
        const value = JSON.parse(candidate)
        if (value && typeof value === 'object') return value as Record<string, unknown>
      } catch {
        /* try the next repair */
      }
    }
    throw new Error(`Could not parse tool arguments: ${raw.slice(0, 200)}`)
  }
}
