import { randomUUID } from 'node:crypto'
import type { EventMessage, MessageWithParts } from '../../shared/opencode'

export type CompactionTrigger = 'auto' | 'manual' | 'unknown'

export interface CompactionDetails {
  trigger?: CompactionTrigger
  preTokens?: number
  postTokens?: number
  /** Lab can omit old turns to stay within a local model's budget without
   *  actually summarizing them. That deserves a warning, not a claim that a
   *  summary was produced. */
  overflow?: boolean
}

function finiteTokenCount(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** A durable transcript marker for compaction events a backend reports only
 *  out-of-band. The local id prefix keeps reconciliation with native history
 *  from deleting a marker the backend can never return as a chat message. */
export function compactionNotice(sessionID: string, details: CompactionDetails = {}): MessageWithParts {
  const messageID = `compaction-notice-${randomUUID()}`
  const created = Date.now()
  const trigger = details.trigger ?? 'unknown'
  const preTokens = finiteTokenCount(details.preTokens)
  const postTokens = finiteTokenCount(details.postTokens)
  return {
    info: { id: messageID, sessionID, role: 'user', time: { created, completed: created } },
    parts: [{
      id: `${messageID}-part`,
      type: 'compaction',
      sessionID,
      messageID,
      ...(trigger === 'auto' ? { auto: true } : {}),
      ...(details.overflow ? { overflow: true } : {}),
      time: { created, completed: created },
      state: {
        status: 'completed',
        metadata: {
          trigger,
          ...(preTokens !== undefined ? { preTokens } : {}),
          ...(postTokens !== undefined ? { postTokens } : {})
        }
      }
    }]
  }
}

export function compactionNoticeEvents(sessionID: string, details: CompactionDetails = {}): EventMessage[] {
  const notice = compactionNotice(sessionID, details)
  return [
    { type: 'message.updated', message: notice.info },
    ...notice.parts.map((part): EventMessage => ({ type: 'message.part.updated', part }))
  ]
}

export function compactionStartedEvent(
  sessionID: string,
  trigger: CompactionTrigger = 'unknown'
): EventMessage {
  return { type: 'session.compaction.started', sessionID, trigger }
}

export function compactionCompletedEvents(sessionID: string, details: CompactionDetails = {}): EventMessage[] {
  const trigger = details.trigger ?? 'unknown'
  return [
    ...compactionNoticeEvents(sessionID, { ...details, trigger }),
    {
      type: 'session.compacted',
      sessionID,
      trigger,
      preTokens: finiteTokenCount(details.preTokens),
      postTokens: finiteTokenCount(details.postTokens)
    }
  ]
}
