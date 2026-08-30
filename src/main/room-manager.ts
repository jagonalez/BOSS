import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { BackendId } from '../shared/backend'
import type { JobNotes, RoomParticipant, RoomRole, RoomShape, RoomState, RoomTeam } from '../shared/room'
// @ts-expect-error Node's type-stripping test runner needs the extension.
import { PARTICIPANT_STALE_AFTER_MS, ROOM_ASSISTANT_ID, emptyRoomState, participantIsStale } from '../shared/room.ts'

interface StoredRoomState {
  version: 1
  rooms: Record<string, RoomState>
  team?: RoomTeam
}

/** Everything the room manager needs from the wider app.
 *
 *  Kept narrow on purpose: the manager decides who is in a room and what
 *  survives their session, and knows nothing about how a backend runs. */
export interface RoomHost {
  /** Start a hidden thread for one participant. A room's participants each run
   *  their own session, so a reviewer can run on a different model from the
   *  builder — which is the whole reason a reviewer is believed. */
  createParticipantThread(input: {
    roomThreadId: string
    roleId: string
    backendId: BackendId
    executionPath: string
  }): Promise<string>
  /** Drop a participant's hidden thread once it goes stale. */
  disposeParticipantThread(threadId: string): Promise<void>
  /** Where a room's work happens, so a new participant lands in the same
   *  checkout as the rest. */
  roomPaths(roomThreadId: string): { projectPath: string; executionPath: string } | undefined
}

/** Roles BOSS proposes when a user has connected agents but never opened setup.
 *
 *  These are defaults, not a fixed vocabulary. The user renames them freely, so
 *  nothing downstream may assume these ids or labels exist. */
export function suggestedRoles(available: readonly BackendId[]): RoomRole[] {
  if (available.length === 0) return []
  const strongest = available.includes('claude') ? 'claude' : available[0]
  const builder = available.includes('codex') ? 'codex' : strongest
  /* The reviewer deliberately differs from the builder when there is a choice.
   * A second opinion from the same model is not a second opinion. */
  const reviewer = available.find((id) => id !== builder) ?? builder
  return [
    { id: 'researcher', label: 'Researcher', backendId: strongest, mode: 'plan' },
    { id: 'planner', label: 'Planner', backendId: strongest, mode: 'plan' },
    { id: 'builder', label: 'Builder', backendId: builder, mode: 'auto' },
    { id: 'reviewer', label: 'Reviewer', backendId: reviewer, mode: 'plan' },
    { id: 'releaser', label: 'Releaser', backendId: builder, mode: 'ask' }
  ]
}

/** Which roles a shape uses, in the order they join.
 *
 *  A one-line fix should not need a plan, a builder, and a reviewer. The user
 *  picks the shape; this only says what that choice means. */
export function rolesForShape(shape: RoomShape, team: RoomTeam): string[] {
  const has = (id: string): boolean => team.roles.some((role) => role.id === id)
  const pick = (...ids: string[]): string[] => ids.filter(has)
  if (shape === 'direct') return pick('builder')
  if (shape === 'reviewed') return pick('builder', 'reviewer')
  return pick('researcher', 'planner', 'builder', 'reviewer')
}

export class RoomManager {
  private readonly stateFile: string
  private readonly host: RoomHost
  private readonly clock: () => number
  private loaded = false
  private rooms: Record<string, RoomState> = {}
  private team?: RoomTeam
  private pendingMutation: Promise<void> = Promise.resolve()

  constructor(stateFile: string, host: RoomHost, clock: () => number = Date.now) {
    this.stateFile = stateFile
    this.host = host
    this.clock = clock
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed = JSON.parse(await readFile(this.stateFile, 'utf8')) as Partial<StoredRoomState>
      if (parsed.version !== 1) return
      if (parsed.rooms && typeof parsed.rooms === 'object') this.rooms = parsed.rooms
      if (parsed.team) this.team = parsed.team
    } catch {
      /* First launch or a corrupt optional state file starts empty. */
    }
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.stateFile), { recursive: true })
    const state: StoredRoomState = { version: 1, rooms: this.rooms, ...(this.team ? { team: this.team } : {}) }
    await writeFile(this.stateFile, JSON.stringify(state, null, 2))
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pendingMutation.then(operation, operation)
    this.pendingMutation = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  async currentTeam(): Promise<RoomTeam | undefined> {
    await this.load()
    return this.team
  }

  async configureTeam(team: RoomTeam): Promise<RoomTeam> {
    return this.mutate(async () => {
      await this.load()
      this.team = team
      await this.save()
      return team
    })
  }

  async room(threadId: string): Promise<RoomState> {
    await this.load()
    return this.rooms[threadId] ?? emptyRoomState()
  }

  /** Remember who the composer is addressed to.
   *
   *  It stays where the user left it. A run of messages to one participant
   *  should not need the name retyped, and an unaddressed message is never
   *  allowed. */
  async setRecipient(threadId: string, recipient: string): Promise<RoomState> {
    return this.mutate(async () => {
      await this.load()
      const room = this.rooms[threadId] ?? emptyRoomState()
      const next: RoomState = { ...room, recipient }
      this.rooms[threadId] = next
      await this.save()
      return next
    })
  }

  async setShape(threadId: string, shape: RoomShape): Promise<RoomState> {
    return this.mutate(async () => {
      await this.load()
      const room = this.rooms[threadId] ?? emptyRoomState()
      const next: RoomState = { ...room, shape }
      this.rooms[threadId] = next
      await this.save()
      return next
    })
  }

  /** Bring a participant into the room, starting its hidden thread.
   *
   *  Participants join when the work reaches them: a reviewer appears once the
   *  builder finishes, not before. Joining twice is a no-op so a repeated
   *  mention cannot spawn a second session. */
  async join(threadId: string, roleId: string): Promise<RoomParticipant | undefined> {
    return this.mutate(async () => {
      await this.load()
      const team = this.team
      if (!team) return undefined
      const role = team.roles.find((entry) => entry.id === roleId)
      if (!role) return undefined
      const room = this.rooms[threadId] ?? emptyRoomState()
      const existing = room.participants.find((entry) => entry.roleId === roleId)
      if (existing && existing.state !== 'done') return existing

      const paths = this.host.roomPaths(threadId)
      if (!paths) return undefined
      const participantThreadId = await this.host.createParticipantThread({
        roomThreadId: threadId,
        roleId,
        backendId: role.backendId,
        executionPath: paths.executionPath
      })
      const now = this.clock()
      const participant: RoomParticipant = {
        roleId,
        label: role.label,
        backendId: role.backendId,
        threadId: participantThreadId,
        state: 'active',
        lastActiveAt: now,
        joinedAt: now
      }
      this.rooms[threadId] = {
        ...room,
        participants: [...room.participants.filter((entry) => entry.roleId !== roleId), participant]
      }
      await this.save()
      return participant
    })
  }

  /** Note that a participant just spoke or was spoken to, so it does not go
   *  stale while it is in use. */
  async touch(threadId: string, roleId: string, state?: RoomParticipant['state']): Promise<void> {
    await this.mutate(async () => {
      await this.load()
      const room = this.rooms[threadId]
      if (!room) return
      const now = this.clock()
      this.rooms[threadId] = {
        ...room,
        participants: room.participants.map((entry) =>
          entry.roleId === roleId ? { ...entry, lastActiveAt: now, ...(state ? { state } : {}) } : entry
        )
      }
      await this.save()
    })
  }

  /** Drop the sessions of participants that have been idle too long.
   *
   *  A stale participant is replaced rather than resumed. Providers discount
   *  recently-sent context for minutes to about an hour; past that a large old
   *  session costs its full size on every mention. Replacing it is also more
   *  honest, because a two-week-old planner would otherwise speak confidently
   *  about code that has since moved. Its notes are what carry forward. */
  async retireStale(threadId: string): Promise<string[]> {
    return this.mutate(async () => {
      await this.load()
      const room = this.rooms[threadId]
      if (!room) return []
      const now = this.clock()
      const retired: string[] = []
      const participants = await Promise.all(
        room.participants.map(async (entry) => {
          if (entry.state === 'stale' || !participantIsStale(entry, now)) return entry
          retired.push(entry.roleId)
          if (entry.threadId) await this.host.disposeParticipantThread(entry.threadId)
          const { threadId: _dropped, ...rest } = entry
          return { ...rest, state: 'stale' as const }
        })
      )
      if (retired.length === 0) return []
      this.rooms[threadId] = { ...room, participants }
      await this.save()
      return retired
    })
  }

  /** Record what survives a participant's session.
   *
   *  Scoped to one job and carried as long as that job runs. This is not memory
   *  across jobs and never holds user preferences. */
  async recordNotes(threadId: string, patch: Partial<Omit<JobNotes, 'updatedAt'>>): Promise<JobNotes> {
    return this.mutate(async () => {
      await this.load()
      const room = this.rooms[threadId] ?? emptyRoomState()
      const notes: JobNotes = {
        agreed: patch.agreed ?? room.notes.agreed,
        decided: patch.decided ?? room.notes.decided,
        changed: patch.changed ?? room.notes.changed,
        updatedAt: this.clock()
      }
      this.rooms[threadId] = { ...room, notes }
      await this.save()
      return notes
    })
  }

  /** What a fresh participant reads when it joins or replaces a stale one.
   *
   *  Deliberately not the previous participant's transcript. A reviewer that
   *  only has the plan and the diff cannot be misled by the builder's account
   *  of itself, and that is exactly why its verdict is worth something. */
  briefFor(notes: JobNotes): string {
    const lines: string[] = []
    if (notes.agreed.length > 0) {
      lines.push('AGREED')
      for (const item of notes.agreed) lines.push(`· ${item}`)
    }
    if (notes.decided.length > 0) {
      if (lines.length > 0) lines.push('')
      lines.push('DECIDED')
      for (const item of notes.decided) lines.push(`· ${item.text} (${item.by})`)
    }
    if (notes.changed.length > 0) {
      if (lines.length > 0) lines.push('')
      lines.push('CHANGED')
      for (const item of notes.changed) lines.push(`· ${item}`)
    }
    return lines.join('\n')
  }

  /** Forget a room once its thread is gone, so state does not accumulate for
   *  threads the user deleted. */
  async forget(threadId: string): Promise<void> {
    await this.mutate(async () => {
      await this.load()
      if (!this.rooms[threadId]) return
      delete this.rooms[threadId]
      await this.save()
    })
  }
}

export { PARTICIPANT_STALE_AFTER_MS, ROOM_ASSISTANT_ID }
