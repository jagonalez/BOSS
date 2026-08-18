import type { BackendId } from './backend'

/** One worker in a fan-out: which backend runs it, and on what model. */
export interface FanOutWorker {
  backendId: BackendId
  /** Distinguishes two workers on the same backend. Optional, and only used
   *  for the thread title, so an unlabelled worker still runs. */
  label?: string
}

export const FAN_OUT_MIN_WORKERS = 2
export const FAN_OUT_MAX_WORKERS = 5

/** Reject a fan-out that cannot produce a comparison.
 *
 *  Returns the reason, or undefined when the request is sound. One worker is
 *  a delegate, not a fan-out, and the caller should use that instead. */
export function fanOutViolation(workers: FanOutWorker[]): string | undefined {
  if (workers.length < FAN_OUT_MIN_WORKERS) {
    return `A fan-out needs at least ${FAN_OUT_MIN_WORKERS} workers. Delegate instead for a single worker.`
  }
  if (workers.length > FAN_OUT_MAX_WORKERS) {
    return `A fan-out is capped at ${FAN_OUT_MAX_WORKERS} workers.`
  }
  return undefined
}

/** Name a worker's thread so two attempts on one backend stay distinguishable. */
export function fanOutTitle(task: string, worker: FanOutWorker, index: number): string {
  const short = task.replace(/\s+/g, ' ').trim().slice(0, 40)
  const suffix = worker.label?.trim() || `#${index + 1}`
  return `Attempt ${suffix} · ${short}${task.length > 40 ? '…' : ''}`
}
