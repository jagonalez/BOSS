/**
 * Replay buffer backing event resume.
 *
 * A phone that locks, loses signal, or sleeps must be able to ask "what did I
 * miss?" and either receive it or be told plainly that it fell too far behind.
 * Silently delivering a partial stream is the failure this exists to prevent:
 * a thread that looks complete but is missing messages is worse than one that
 * visibly reloads.
 *
 * Kept separate from the relay client so the sequencing rules are testable
 * without a socket, a desktop, or a live relay.
 */

export interface BufferedEvent {
  event: Record<string, unknown>
  seq: number
}

export interface ResumeResult {
  events: BufferedEvent[]
  /** The requested point had already been evicted; the caller must refetch. */
  gap: boolean
  /** Latest sequence the buffer has seen, so a gapped phone can resync to it. */
  seq: number
}

export class EventBuffer {
  private readonly entries: BufferedEvent[] = []
  private seq = 0

  private readonly capacity: number

  // A plain assignment rather than a parameter property: Node's type-stripping
  // test runner rejects the shorthand.
  constructor(capacity: number) {
    this.capacity = capacity
  }

  /** Number and retain an event. Returns the sequence assigned to it. */
  push(event: Record<string, unknown>): number {
    const seq = ++this.seq
    this.entries.push({ event, seq })
    if (this.entries.length > this.capacity) this.entries.shift()
    return seq
  }

  get latest(): number {
    return this.seq
  }

  get size(): number {
    return this.entries.length
  }

  /**
   * Everything after `since`.
   *
   * `since` of 0 means a phone that has never applied an event: it gets no
   * replay and no gap, because it will load current state anyway.
   *
   * A gap is reported when the next event the phone needs — `since + 1` — is
   * older than the oldest entry still held.
   */
  since(since: number): ResumeResult {
    if (since <= 0) return { events: [], gap: false, seq: this.seq }
    // Ahead of us: a desktop restart reset the counter. Treat it as a gap so
    // the phone refetches rather than waiting for sequences that never come.
    if (since > this.seq) return { events: [], gap: true, seq: this.seq }
    const oldest = this.entries[0]?.seq
    if (oldest !== undefined && since + 1 < oldest) return { events: [], gap: true, seq: this.seq }
    return { events: this.entries.filter((entry) => entry.seq > since), gap: false, seq: this.seq }
  }
}
