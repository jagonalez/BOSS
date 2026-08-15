import type { BackendDescriptor } from '@shared/backend'

/** Whether a thread is working, and so shows a Thinking or Working label.
 *
 *  Main owns this. It marks a thread busy when it sends, before any backend
 *  event, and clears it on idle, error, or abort. The renderer used to infer it
 *  instead, from running parts and message timestamps inside a grace window
 *  after each send: a late busy event meant no label at all, and an expired
 *  window meant a finished run still looked alive.
 *
 *  `live` is what the latest event said, `published` is what the thread itself
 *  reports — the fallback for a window that opened or reloaded mid-run and
 *  never saw the event. */
export function threadIsWorking(
  live: boolean | undefined,
  published: boolean | undefined,
  compacting: boolean | undefined
): boolean {
  return Boolean(live ?? published ?? false) || Boolean(compacting)
}

/** When a turn finished, given the messages that make it up.
 *
 *  Undefined until every message has completed. A turn is one bubble made of
 *  several assistant messages, and taking the latest completion regardless
 *  reported the turn as done while one of its messages was still running —
 *  the same field that decides whether the thread still looks busy. */
export function turnCompletedAt(completions: Array<number | undefined>): number | undefined {
  if (completions.length === 0) return undefined
  return completions.every((time): time is number => typeof time === 'number')
    ? Math.max(...completions)
    : undefined
}

export function serviceDegradations(
  serverUrl: string,
  serverHealthy: boolean,
  backends: BackendDescriptor[]
): string[] {
  const issues: string[] = []
  if (serverUrl && !serverHealthy) issues.push('Core project service unavailable')
  for (const backend of backends) {
    if (backend.id !== 'opencode' && backend.available && !backend.healthy) issues.push(`${backend.label} is not responding`)
  }
  return issues
}
