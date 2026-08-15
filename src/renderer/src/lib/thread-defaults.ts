import type { BackendModeId, BackendModelPreference } from '@shared/backend'

/** What a thread runs at, given what it was set to and what its backend
 *  defaults to.
 *
 *  Kept apart from the store so the rules can be tested. They are small but
 *  easy to get subtly wrong, and getting them wrong means an agent runs with
 *  permissions nobody chose. */

/** The permission mode for a thread.
 *
 *  Its own setting, then its backend's default, then the app's. Per backend
 *  because the modes are the backend's own: codex has no accept-edits and pi
 *  has one mode, so a single setting for all of them would name something half
 *  cannot do. Anything the backend does not offer falls back to its first mode
 *  rather than being passed through. */
export function resolveMode(
  own: BackendModeId | undefined,
  backendDefault: BackendModeId | undefined,
  appDefault: BackendModeId,
  offered: BackendModeId[]
): BackendModeId {
  const requested = own || backendDefault || appDefault
  if (offered.includes(requested)) return requested
  return offered[0] ?? requested
}

/** The thinking level for a thread.
 *
 *  A level belongs to the model it was saved against — claude's Sonnet stops at
 *  high where Opus goes to max, and codex reads the levels from each model — so
 *  a default only applies while the thread is on that model. On any other, the
 *  backend picks its own rather than being asked for a level it may not have.
 *
 *  `hasOwn` rather than a truthy check: a thread set explicitly to no thinking
 *  stores null, and that is a choice, not an absence. */
export function resolveVariant(
  ownSet: boolean,
  own: string | null,
  model: string | undefined,
  preference: BackendModelPreference | undefined,
  appDefault: string | null
): string | null {
  if (ownSet) return own
  if (preference?.variant && model === preference.modelID) return preference.variant
  return appDefault
}
