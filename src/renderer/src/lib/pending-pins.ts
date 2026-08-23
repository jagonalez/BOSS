import type { SessionInfo } from '@shared/opencode'

interface PendingPin {
  generation: number
  pinned: boolean
}

/** Pin choices that main has not acknowledged yet.
 *
 * Session refreshes are independent requests and can finish while a pin write
 * is in flight. Overlaying the latest choice keeps such a refresh from moving
 * the row back, while the generation prevents an older success or failure from
 * settling a newer click. */
export class PendingPins {
  private generation = 0
  private readonly values = new Map<string, PendingPin>()

  begin(threadId: string, pinned: boolean): number {
    const generation = ++this.generation
    this.values.set(threadId, { generation, pinned })
    return generation
  }

  settle(threadId: string, generation: number): boolean {
    if (this.values.get(threadId)?.generation !== generation) return false
    this.values.delete(threadId)
    return true
  }

  apply(sessions: SessionInfo[]): SessionInfo[] {
    return sessions.map((session) => {
      const pending = this.values.get(session.id)
      return pending ? { ...session, pinned: pending.pinned } : session
    })
  }
}
