/** Minimal Server-Sent Events parser for OpenAI-compatible streaming.
 *
 *  Kept framework-free and pure so it can be unit-tested directly and reused
 *  against any vendor's SSE flavour (blank-line separated events, `data:`
 *  fields, comment keep-alives, and the `[DONE]` sentinel). */
export type SseEvent =
  | { type: 'data'; data: string }
  | { type: 'done' }

/** Parse every complete event in `raw`. A trailing event that has not yet been
 *  terminated by a blank line is returned as `remainder`, ready to be prepended
 *  to the next chunk. */
function consumeSse(raw: string): { events: SseEvent[]; remainder: string } {
  const events: SseEvent[] = []
  const lines = raw.split('\n')
  let blockStart = 0
  let data: string[] = []
  let closed = true

  const flush = (nextStart: number): void => {
    const payload = data.join('\n')
    if (payload === '[DONE]') events.push({ type: 'done' })
    else if (payload.length > 0) events.push({ type: 'data', data: payload })
    data = []
    blockStart = nextStart
    closed = true
  }

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx].replace(/\r$/, '')
    if (line === '') {
      flush(idx + 1)
      continue
    }
    if (line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon >= 0 ? line.slice(0, colon) : line
    if (field !== 'data') continue
    const value = colon >= 0 ? line.slice(colon + 1) : ''
    data.push(value.startsWith(' ') ? value.slice(1) : value)
    closed = false
  }

  const remainder = closed ? '' : lines.slice(blockStart).join('\n')
  return { events, remainder }
}

export function parseSseEvents(raw: string): SseEvent[] {
  return consumeSse(raw).events
}

/** Incremental decoder: feed network chunks in and get complete events out. */
export class SseDecoder {
  private buffer = ''

  push(chunk: string): SseEvent[] {
    this.buffer += chunk
    const { events, remainder } = consumeSse(this.buffer)
    this.buffer = remainder
    return events
  }

  flush(): SseEvent[] {
    const { events, remainder } = consumeSse(this.buffer)
    this.buffer = remainder
    return events
  }
}
