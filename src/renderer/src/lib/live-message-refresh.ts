interface ThreadActivity {
  sessionBusy: Record<string, boolean | undefined>
  streaming: Record<string, boolean | undefined>
}

/** Live message events already contain the renderer update they announce.
 * Refetching the complete history while those events stream duplicates work
 * and, for image-heavy Codex sessions, repeatedly transfers large payloads. */
export function shouldScheduleMessageHistoryRefresh(
  state: ThreadActivity,
  sessionId: string
): boolean {
  return !state.sessionBusy[sessionId] && !state.streaming[sessionId]
}
