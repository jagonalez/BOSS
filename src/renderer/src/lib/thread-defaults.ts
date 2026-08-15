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

/** The model a thread runs on, and the provider that serves it.
 *
 *  This window's choice, then main's copy, then the app's. The local choice
 *  leads because picking a model only writes renderer state — main learns of it
 *  with the next message, so preferring main would snap the picker back until
 *  then.
 *
 *  Main's copy matters for a thread an agent created: those resolve their model
 *  in main and never pass through renderer state, so without it the app default
 *  showed through — the model last picked in some other thread, not the one
 *  this thread runs on.
 *
 *  The provider follows whichever model won, never a mix: a provider paired
 *  with another source's model describes a pairing that does not exist. */
export function resolveModel(
  own: { modelID?: string; providerID?: string | null } | undefined,
  fromMain: { modelID?: string; providerID?: string } | undefined,
  appDefault: { modelID: string | null; providerID: string | null }
): { modelID: string | null; providerID: string | null } {
  if (own?.modelID) return { modelID: own.modelID, providerID: own.providerID ?? appDefault.providerID }
  if (fromMain?.modelID) return { modelID: fromMain.modelID, providerID: fromMain.providerID ?? null }
  return appDefault
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
