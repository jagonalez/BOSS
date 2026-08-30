import type { BackendId, BackendModeId } from './backend'
import type { SessionModel } from './opencode'

/** A thread is a room: several named participants share one message list.
 *
 *  Every participant runs its own backend session, so a reviewer can run on a
 *  different model from the builder — which is the whole reason a reviewer is
 *  believed. Those sessions stay hidden; the user sees one conversation.
 *
 *  `ROOM_ASSISTANT_ID` and `ROOM_USER_ID` are reserved. Everything else is a
 *  role the user named in setup, so the ids here are opaque strings rather than
 *  a fixed union. */
export const ROOM_ASSISTANT_ID = 'boss'
export const ROOM_USER_ID = 'you'

/** Addressed to every participant. Each replies once; they never reply to each
 *  other, which is where a room turns into noise. */
export const ROOM_EVERYONE = 'everyone'

/** How BOSS was told to run a job. The user picks this, never BOSS.
 *
 *  - `direct` — one participant, no review. A one-line fix should not need a
 *    plan, a builder, and a reviewer.
 *  - `reviewed` — a participant builds, a fresh one reviews.
 *  - `full` — research, plan, build, review. */
export type RoomShape = 'direct' | 'reviewed' | 'full'

export const ROOM_SHAPES: readonly RoomShape[] = ['direct', 'reviewed', 'full']

export function isRoomShape(value: unknown): value is RoomShape {
  return typeof value === 'string' && (ROOM_SHAPES as readonly string[]).includes(value)
}

/** A role the user configured once, in setup. Names are theirs — "builder" and
 *  "reviewer" are only defaults, and nothing in the code may assume them. */
export interface RoomRole {
  id: string
  /** What the user calls it. Shown on every message it sends. */
  label: string
  backendId: BackendId
  model?: SessionModel
  /** Permission stance. Setup asks when to stop and ask in plain words; this is
   *  the machine-facing result, and is never named in the UI. */
  mode?: BackendModeId
  /** Extra standing instruction for this role, from setup. BOSS owns the good
   *  role prompts; the user configures intent and authority, not prose. */
  instruction?: string
}

/** What the user's team looks like. Configured once. Project overrides come
 *  later; there are deliberately no profiles or inheritance editors. */
export interface RoomTeam {
  version: 1
  roles: RoomRole[]
  /** Whether BOSS asks which shape to use, or silently reuses the last answer.
   *  The user decides the shape either way — BOSS never picks it. */
  askShape: boolean
  /** Default when `askShape` is false. */
  defaultShape: RoomShape
}

export type ParticipantState =
  /** In the room and reachable. */
  | 'active'
  /** Running right now. */
  | 'working'
  /** Idle long enough that its session was dropped. Addressing it starts a
   *  fresh one that reads the job notes. */
  | 'stale'
  /** Finished its part and left. Its notes remain. */
  | 'done'

/** One named agent inside one room. */
export interface RoomParticipant {
  /** Matches `RoomRole.id`, or `ROOM_ASSISTANT_ID`. */
  roleId: string
  label: string
  backendId: BackendId
  /** The hidden thread this participant runs in. Absent until it first speaks,
   *  and cleared when it goes stale. */
  threadId?: string
  state: ParticipantState
  /** When it last sent or received a message. Drives staleness. */
  lastActiveAt?: number
  /** When it joined the room. Participants join when the work reaches them, so
   *  a reviewer is not listed before it exists. */
  joinedAt: number
}

/** A participant idle beyond this is replaced rather than resumed.
 *
 *  Providers discount recently-sent context for minutes to about an hour. Past
 *  that there is no discount left, so resuming a large old session costs its
 *  full size every time it is addressed. Replacing it and reading the notes is
 *  both cheaper and more honest: a two-week-old planner would otherwise speak
 *  confidently about code that has since moved. */
export const PARTICIPANT_STALE_AFTER_MS = 60 * 60 * 1000

export function participantIsStale(participant: RoomParticipant, now: number): boolean {
  if (participant.state === 'done') return false
  // Falls back to when it joined. One that arrived and was never spoken to
  // still holds a session, and leaving it open forever costs the same as one
  // that spoke once and went quiet.
  const since = participant.lastActiveAt ?? participant.joinedAt
  return now - since > PARTICIPANT_STALE_AFTER_MS
}

/** What survives a participant's session.
 *
 *  Scoped to one job and carried as long as that job runs. This is not memory
 *  across jobs, and it never holds user preferences — the user was explicit
 *  that nothing should be learned about them between tasks. */
export interface JobNotes {
  /** What the user and the participants agreed to do. */
  agreed: string[]
  /** Choices made along the way, each with when it was made. */
  decided: JobDecision[]
  /** What actually changed, in plain words. */
  changed: string[]
  updatedAt: number
}

export interface JobDecision {
  text: string
  at: number
  /** Which participant made or recorded it. */
  by: string
}

export const EMPTY_JOB_NOTES: JobNotes = { agreed: [], decided: [], changed: [], updatedAt: 0 }

/** The room's own state, stored beside the thread. */
export interface RoomState {
  version: 1
  participants: RoomParticipant[]
  notes: JobNotes
  shape?: RoomShape
  /** Who the composer is addressed to. Stays where the user left it: a run of
   *  messages to one participant should not need the name retyped. */
  recipient: string
}

export function emptyRoomState(recipient = ROOM_ASSISTANT_ID): RoomState {
  return { version: 1, participants: [], notes: { ...EMPTY_JOB_NOTES }, recipient }
}

export function findParticipant(room: RoomState, roleId: string): RoomParticipant | undefined {
  return room.participants.find((participant) => participant.roleId === roleId)
}

/** Who can be addressed right now. BOSS is always available; roles appear once
 *  they have joined. */
export function addressable(room: RoomState): RoomParticipant[] {
  return room.participants.filter((participant) => participant.state !== 'done')
}

/** Resolve a typed `@name` against the room, case-insensitively.
 *
 *  Matches the label the user chose, then the role id, so "@Builder" and
 *  "@builder" both land. Returns undefined rather than guessing: addressing the
 *  wrong agent is worse than asking again. */
export function resolveMention(room: RoomState, name: string): string | undefined {
  const wanted = name.trim().toLowerCase().replace(/^@/, '')
  if (!wanted) return undefined
  if (wanted === ROOM_EVERYONE) return ROOM_EVERYONE
  if (wanted === ROOM_ASSISTANT_ID) return ROOM_ASSISTANT_ID
  for (const participant of room.participants) {
    if (participant.label.toLowerCase() === wanted) return participant.roleId
    if (participant.roleId.toLowerCase() === wanted) return participant.roleId
  }
  return undefined
}

/** Strip a leading mention from composed text.
 *
 *  The chip already carries the recipient, so a typed "@builder do the thing"
 *  should reach the builder as "do the thing". Only a leading mention is
 *  removed; one mid-sentence is prose the agent should see. */
export function stripLeadingMention(text: string): string {
  return text.replace(/^\s*@[\w-]+[,:]?\s+/, '')
}
