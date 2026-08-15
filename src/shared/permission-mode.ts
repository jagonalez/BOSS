import type { BackendModeId } from './backend'

/** How BOSS answers a permission request, given a thread's mode.
 *
 *  Kept apart from the backend manager so it can be tested directly, and so
 *  there is one place that decides. Every surface — the desktop window, the
 *  mobile page, an automation — goes through the manager, which calls this.
 *
 *  'once' allows this request only. Auto deliberately does not answer 'always':
 *  a lasting grant would outlive a switch back to Ask, which is exactly the
 *  stale-state bug this function exists to prevent.
 *
 *  Returns undefined when the user must decide. */
export function hostPermissionResponse(mode: BackendModeId): 'once' | 'reject' | undefined {
  if (mode === 'plan') return 'reject'
  if (mode === 'auto') return 'once'
  // 'ask' prompts, and 'accept-edits' lets the backend apply its own edit
  // policy and prompt for whatever it does not cover.
  return undefined
}

/** The mode a thread is in, given what was stored and what its backend offers.
 *
 *  A stored mode its backend does not have would silently decide nothing, so it
 *  falls back to the backend's first mode instead. */
export function resolveThreadMode(stored: BackendModeId | undefined, available: readonly BackendModeId[]): BackendModeId {
  if (stored && available.includes(stored)) return stored
  return available[0] ?? 'ask'
}
