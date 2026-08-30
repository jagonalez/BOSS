import type { RoomState } from '../../../shared/room'
// @ts-expect-error Node's type-stripping test runner needs the extension.
import { ROOM_ASSISTANT_ID, ROOM_EVERYONE, ROOM_THREAD_AGENT, resolveMention } from '../../../shared/room.ts'

/** One option in the recipient chip's menu. */
export interface RecipientOption {
  id: string
  label: string
  /** What it is doing, shown beside the name. Empty when there is nothing worth
   *  saying. */
  detail: string
  /** Colours the chip. BOSS and a broadcast read differently from a worker. */
  kind: 'assistant' | 'participant' | 'everyone'
}

const STATE_DETAIL: Record<string, string> = {
  active: '',
  working: 'working',
  stale: 'idle',
  done: 'finished'
}

/** Who this thread can be addressed to, in menu order.
 *
 *  Participants first, because they are what the user is working with. BOSS and
 *  a broadcast come last and are always present: a room with no participants
 *  yet can still be talked to, and a broadcast that reaches nobody is harmless
 *  rather than an error. */
export function recipientOptions(room: RoomState, threadAgent?: string): RecipientOption[] {
  const participants = room.participants
    .filter((entry) => entry.state !== 'done')
    .map((entry) => ({
      id: entry.roleId,
      label: entry.label,
      detail: STATE_DETAIL[entry.state] ?? '',
      kind: 'participant' as const
    }))
  return [
    // The thread's own agent, first, and offered only while the thread has no
    // roles yet. Once it is a room, its participants are named and this would
    // be a second name for one of them.
    ...(participants.length === 0 && threadAgent
      ? [{ id: ROOM_THREAD_AGENT, label: threadAgent, detail: '', kind: 'participant' as const }]
      : []),
    ...participants,
    { id: ROOM_ASSISTANT_ID, label: 'BOSS', detail: 'assistant', kind: 'assistant' as const },
    { id: ROOM_EVERYONE, label: 'Everyone', detail: 'one reply each', kind: 'everyone' as const }
  ]
}

/** Send this one message to a different agent, without changing the team.
 *
 *  A reviewer that is doing badly on one job should not mean editing the team
 *  and remembering to put it back. The override lasts for the message, and the
 *  role keeps its own agent for everything else.
 *
 *  Returned as `role@agent` so it survives as one value through the composer
 *  and the send, rather than needing a second field everywhere. */
export function overrideFor(recipient: string, backendId: string): string {
  return `${recipient}@${backendId}`
}

export function splitOverride(recipient: string): { roleId: string; backendId?: string } {
  const at = recipient.lastIndexOf('@')
  if (at <= 0) return { roleId: recipient }
  return { roleId: recipient.slice(0, at), backendId: recipient.slice(at + 1) }
}

export function recipientLabel(room: RoomState, id: string, threadAgent?: string): string {
  const { roleId, backendId } = splitOverride(id)
  const label = recipientOptions(room, threadAgent).find((option) => option.id === roleId)?.label
    ?? threadAgent
    ?? 'BOSS'
  // The agent is named only when it is not the one the role normally uses, so
  // an ordinary message stays one word.
  return backendId ? `${label} · ${backendId}` : label
}

export function recipientKind(room: RoomState, id: string, threadAgent?: string): RecipientOption['kind'] {
  const { roleId } = splitOverride(id)
  return recipientOptions(room, threadAgent).find((option) => option.id === roleId)?.kind
    ?? (roleId === ROOM_THREAD_AGENT ? 'participant' : 'assistant')
}

/** What typing in the composer should do to the chip.
 *
 *  A leading `@name` retargets the message and is then removed from the text,
 *  because the chip already carries it. The user asked for exactly this: the
 *  chip stays where they left it, and typing a name is the fast way to change
 *  it rather than a second thing to maintain. */
export interface RetargetResult {
  recipient?: string
  text: string
}

export function retarget(room: RoomState, text: string): RetargetResult {
  const match = /^\s*@([\w-]+)[,:]?(\s|$)/.exec(text)
  if (!match) return { text }
  const resolved = resolveMention(room, match[1])
  // An unrecognised name is left alone. Silently retargeting to something the
  // user did not mean is worse than doing nothing, and they may simply be
  // writing about a person or a file.
  if (!resolved) return { text }
  return { recipient: resolved, text: text.slice(match[0].length) }
}

/** Whether a message may be sent at all.
 *
 *  A room never allows an unaddressed message, so the only way to be blocked is
 *  addressing someone who has left. Saying so is better than sending into
 *  nowhere. */
export function recipientProblem(room: RoomState, recipient: string): string | undefined {
  if (recipient === ROOM_ASSISTANT_ID || recipient === ROOM_EVERYONE) return undefined
  const participant = room.participants.find((entry) => entry.roleId === recipient)
  if (!participant) return undefined
  if (participant.state === 'done') return `${participant.label} has finished. Pick someone else.`
  return undefined
}
