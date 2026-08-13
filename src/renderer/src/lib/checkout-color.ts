import { useStore, appStore } from '../state/AppState'

/**
 * A colour per checkout — a project's main directory, or one of its worktrees.
 * A workspace mixes threads on purpose: two projects working together, or two
 * worktrees of one repo. Colouring by project handled the first case and made
 * every thread identical in the second, so the checkout is the unit.
 *
 * Nobody solves this inside one window. Peacock and Unique Window Colors both
 * colour a whole editor window, and Peacock's multi-root support is still an
 * open issue for exactly this reason.
 */

/**
 * Assigned by position among the open checkouts, not hashed from the path.
 * Hashing cannot guarantee separation: a ten-colour palette put /dev/ralf and
 * /dev/kato on the same hue, and hashing across the whole wheel put /dev/herdr
 * and /dev/marketing-site three degrees apart. Even spacing holds 32 degrees at
 * ten checkouts.
 *
 * The reds are skipped — they mean failure elsewhere in the app.
 */
const HUE_START = 20
const HUE_RANGE = 320

export function checkoutHue(checkoutPath?: string, openCheckouts: string[] = []): number | undefined {
  if (!checkoutPath) return undefined
  const ordered = [...new Set(openCheckouts.length ? openCheckouts : [checkoutPath])].sort()
  const index = ordered.indexOf(checkoutPath)
  if (index < 0) return HUE_START
  return Math.round(HUE_START + (index * HUE_RANGE) / Math.max(ordered.length, 1))
}

/** A readable accent for text and dots against the app's dark surfaces. */
export function checkoutColor(checkoutPath?: string, openCheckouts: string[] = []): string | undefined {
  const hue = checkoutHue(checkoutPath, openCheckouts)
  return hue === undefined ? undefined : `hsl(${hue} 62% 62%)`
}

/**
 * Reads the open checkouts from the store so callers do not have to thread the
 * set through, and every component agrees on the same hue for a checkout.
 */
export function useCheckoutColor(checkoutPath?: string): string | undefined {
  const known = useStore(appStore, (state) =>
    [...new Set(
      state.sessions
        .map((session) => session.executionPath ?? session.worktree?.path ?? session.projectPath ?? '')
        .filter(Boolean)
    )].sort().join('\n')
  )
  return checkoutColor(checkoutPath, known ? known.split('\n') : [])
}
