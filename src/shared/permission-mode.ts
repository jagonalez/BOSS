import type { BackendModeId } from './backend'

/** How BOSS answers a permission request, given a thread's mode.
 *
 *  Kept apart from the backend manager so it can be tested directly, and so
 *  there is one place that decides. Every surface — the desktop window, the
 *  mobile page, an automation — goes through the manager, which calls this.
 *
 *  `nativeAutoMode` says the backend has an Auto policy of its own. Those
 *  backends decide per tool which calls are safe and send a request only for
 *  the ones they want confirmed, so a request arriving from them is an
 *  escalation and belongs to the user. Answering it here would turn a
 *  graduated Auto into blanket approval — closer to bypassing permissions than
 *  to Auto, and it would throw away the judgement the backend just applied.
 *
 *  Only a backend without its own policy (opencode) is approved for by the
 *  host: there, allowing every request is the only way Auto can mean anything.
 *
 *  'once' allows this request only. Auto deliberately does not answer 'always':
 *  a lasting grant would outlive a switch back to Ask, which is exactly the
 *  stale-state bug this function exists to prevent.
 *
 *  Returns undefined when the user must decide. */
export function hostPermissionResponse(mode: BackendModeId, nativeAutoMode: boolean): 'once' | 'reject' | undefined {
  // Plan is a refusal either way: a read-only thread must not act, and a
  // backend that asks anyway is asking to do something Plan does not allow.
  if (mode === 'plan') return 'reject'
  if (mode === 'auto' && !nativeAutoMode) return 'once'
  // 'ask' prompts. 'accept-edits', and Auto on a backend with its own policy,
  // leave the decision where it belongs and prompt for the rest.
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
