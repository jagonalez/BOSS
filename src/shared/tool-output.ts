/**
 * Shortening tool output for clients that do not render it.
 *
 * A transcript's bytes are overwhelmingly tool output. One real Codex thread
 * here is 4.3MB over the relay, and 91% of that is shell output — single calls
 * returning 100,000 characters, several times over. The phone draws a tool call
 * as one line naming the command, and never shows the output at all, so every
 * one of those bytes is sent and then dropped.
 *
 * So a remote client asks for the output trimmed, and fetches a single part in
 * full through thread.part when a step is opened. The desktop never asks: it
 * has the whole transcript locally and pays nothing to read it.
 */

import type { MessageWithParts, Part } from './opencode'

/** How many characters of output survive, and the full length of what did not.
 *
 *  `outputTruncated` is the original length rather than a boolean so a client
 *  can say how much more there is before asking for it. */
export function trimToolOutput(messages: MessageWithParts[], limit: number): MessageWithParts[] {
  return messages.map((message) => ({
    ...message,
    parts: message.parts.map((part): Part => {
      const tool = part as Part & { state?: { output?: unknown } }
      if (tool.type !== 'tool' || !tool.state) return part
      const output = tool.state.output
      // Objects are stringified to be measured, then kept whole if they are
      // small: re-encoding a short structured result would change its shape
      // for no gain.
      const text = typeof output === 'string' ? output : output === undefined ? '' : JSON.stringify(output)
      if (text.length <= limit) return part
      return {
        ...tool,
        state: { ...tool.state, output: text.slice(0, limit), outputTruncated: text.length }
      }
    })
  }))
}
