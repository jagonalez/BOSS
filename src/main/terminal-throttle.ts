/** Pacing terminal output between the shell and the renderer.
 *
 *  A shell can produce output far faster than a terminal can draw it: `yes`, a
 *  big `cat`, or an agent streaming a build log. Two mechanisms keep that from
 *  drowning the renderer, both modelled on VS Code's terminal.
 *
 *  Batching coalesces the many small chunks node-pty emits within a few
 *  milliseconds into one message, so a burst costs one inter-process hop
 *  rather than hundreds. Flow control stops reading the shell once the
 *  renderer falls far behind. Batching alone does not save you from a runaway
 *  process — it makes each message bigger rather than fewer — so both are
 *  needed.
 *
 *  This holds no pty and no window, which is what lets it be tested directly. */

export const FLUSH_INTERVAL_MS = 5
export const HIGH_WATERMARK_CHARS = 100_000
export const LOW_WATERMARK_CHARS = 5_000

export interface ThrottleCallbacks {
  /** Send a coalesced batch onward. */
  emit(data: string): void
  /** Stop reading the shell; it will block once its pipe fills. */
  pause(): void
  resume(): void
}

export class TerminalThrottle {
  private pending: string[] = []
  private flushTimer: NodeJS.Timeout | null = null
  private unacknowledged = 0
  private isPaused = false
  private started = false
  /** Size of `pending` while held, tracked so trimming stays O(1) per chunk. */
  private heldChars = 0
  private readonly callbacks: ThrottleCallbacks

  // Assigned in the body rather than declared as a parameter property, which
  // Node cannot strip when running the tests directly from TypeScript.
  constructor(callbacks: ThrottleCallbacks) {
    this.callbacks = callbacks
  }

  /** Begin sending. Held output goes out at the next flush.
   *
   *  A shell writes its prompt the moment it spawns, which is before the
   *  renderer knows the id to match that output against — it only learns the
   *  id when the create call returns. Anything sent in that window is
   *  discarded by the receiver and the terminal looks blank. Holding until the
   *  caller says it is listening is what closes that gap. */
  start(): void {
    if (this.started) return
    this.started = true
    if (this.pending.length > 0) this.flush()
  }

  /** Collect a chunk, arming a flush if this is the first of a batch.
   *  The timer is deliberately not reset by later chunks: continuous output
   *  would keep pushing the deadline back and nothing would ever be drawn. */
  push(data: string): void {
    this.pending.push(data)
    if (!this.started) {
      // Held until the renderer is listening. A command that floods on startup
      // could otherwise grow this without limit, so keep only what a terminal
      // could show: the oldest output would have scrolled away regardless.
      this.heldChars += data.length
      while (this.heldChars > HIGH_WATERMARK_CHARS && this.pending.length > 1) {
        this.heldChars -= this.pending.shift()!.length
      }
      return
    }
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => this.flush(), FLUSH_INTERVAL_MS)
  }

  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    // Nobody is listening yet, so hold everything. start() sends it.
    if (!this.started) return
    if (this.pending.length === 0) return
    const data = this.pending.join('')
    this.pending.length = 0

    this.unacknowledged += data.length
    if (!this.isPaused && this.unacknowledged > HIGH_WATERMARK_CHARS) {
      // The renderer is far enough behind that more output would only pile up.
      // Stopping the read makes the shell block on a full pipe, which is the
      // only thing that actually slows a runaway process down.
      this.isPaused = true
      this.callbacks.pause()
    }
    this.callbacks.emit(data)
  }

  /** Report that the renderer has parsed `chars` characters.
   *
   *  Resuming below the low watermark rather than at zero keeps the shell
   *  reading continuously instead of stuttering on every batch. */
  acknowledge(chars: number): void {
    this.unacknowledged = Math.max(0, this.unacknowledged - chars)
    if (this.isPaused && this.unacknowledged < LOW_WATERMARK_CHARS) {
      this.isPaused = false
      this.callbacks.resume()
    }
  }

  /** Drop anything still waiting. The terminal that would have drawn it is
   *  gone, so letting the timer fire would emit data for a dead session. */
  discard(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.pending.length = 0
  }

  get paused(): boolean {
    return this.isPaused
  }
}
