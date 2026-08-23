/** What a per-turn Retry must resend.
 *
 *  This lives apart from ChatView and actions.ts for the same reason
 *  send-recovery.ts does: the rules are pure message-shape logic worth testing
 *  directly, while their callers reach into the store and the preload bridge.
 *
 *  A retry resends the turn's user message as a fresh prompt. It never
 *  truncates history — that would make it a revert, which only some backends
 *  implement. Resending is an ordinary send every backend accepts.
 */

import type { Attachmentish } from './send-recovery'

export interface RetryTurnPayload {
  text: string
  attachments: Attachmentish[]
}

interface RetryTurnPart {
  type?: string
  text?: string
  state?: {
    mime?: string
    url?: string
    name?: string
  }
}

/** Structural on purpose: a test builds plain objects, no shared types needed. */
export interface RetryTurnMessage {
  parts?: RetryTurnPart[]
}

/** The text and image attachments to resend for a user message.
 *
 *  Images ride along when they were attached by the user — those arrive as
 *  data URLs inside the transcript. Screenshots the agent took come back as
 *  boss-image:// pointers into BOSS's own store; resending one as a data URL
 *  would send a broken reference, so only genuine data URLs qualify.
 *
 *  Returns null when there is nothing to resend: no text and no restorable
 *  attachment is not a retry, it is an empty message. */
export function retryTurnPayload(message: RetryTurnMessage | undefined): RetryTurnPayload | null {
  const parts = message?.parts ?? []
  const text = parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .filter(Boolean)
    .join('\n')
  const attachments: Attachmentish[] = parts.flatMap((part, index) => {
    const url = part.state?.url
    if (part.type !== 'file' || !part.state?.mime?.startsWith('image/') || !url?.startsWith('data:')) return []
    return [{
      id: `retry-${index}-${part.state.name ?? 'image'}`,
      name: part.state.name ?? 'image',
      mime: part.state.mime,
      dataUrl: url
    }]
  })
  if (!text.trim() && attachments.length === 0) return null
  return { text, attachments }
}
