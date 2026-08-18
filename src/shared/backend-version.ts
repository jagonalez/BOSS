import type { BackendId } from './backend'

/** The oldest release of each CLI that BOSS has been checked against.
 *
 *  These backends speak protocols BOSS parses by hand — codex's app-server
 *  JSON-RPC, pi's rpc mode, claude's stream-json — and none of them promise a
 *  stable shape across releases. A user upgrading their own binary can
 *  therefore change the protocol underneath BOSS at any time, and the failure
 *  looks like a broken agent rather than a version mismatch.
 *
 *  Raise a floor when a release is known to break BOSS, and only then: the
 *  point is to name versions that are known bad, not to refuse anything that
 *  has not been tested yet.
 *
 *  opencode is absent on purpose. BOSS bundles that binary, so its version is
 *  already pinned and there is no user upgrade to be surprised by. */
export const MINIMUM_BACKEND_VERSIONS: Partial<Record<BackendId, string>> = {
  codex: '0.100.0',
  pi: '0.80.0',
  claude: '2.0.0'
}

/** Whether `version` sorts before `floor`, comparing segment by segment.
 *
 *  Not shared with version.ts's isNewer: that module is imported by the
 *  renderer through a bundler alias, and this one is read by the node test
 *  runner, which resolves paths itself. Six lines of arithmetic is a smaller
 *  cost than making one of those two work differently.
 *
 *  Numeric, not lexical: 0.9.0 is older than 0.100.0 despite sorting after it
 *  as text. */
function isOlderThan(version: string, floor: string): boolean {
  const parse = (value: string): number[] => value.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const left = parse(version)
  const right = parse(floor)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    if (a !== b) return a < b
  }
  return false
}

/** Pull a dotted version out of whatever a CLI prints for --version.
 *
 *  The three backends each answer differently — "codex-cli 0.147.0", a bare
 *  "0.84.1", and "2.1.234 (Claude Code)" — so the number is found anywhere in
 *  the line rather than assumed to be at the front. Returns undefined when
 *  there is no number to read, which is treated as unknown rather than old. */
export function parseBackendVersion(output: string | undefined): string | undefined {
  if (!output) return undefined
  return /(\d+(?:\.\d+)+)/.exec(output)?.[1]
}

/** Why a backend's version is worth mentioning, or undefined when it is fine.
 *
 *  Deliberately advisory. A version below the floor still runs — BOSS cannot
 *  know that a given release is broken, only that it is older than one that
 *  was checked — so this returns something to show the user rather than
 *  blocking the backend. */
export function backendVersionWarning(
  backendId: BackendId,
  rawVersion: string | undefined
): string | undefined {
  const minimum = MINIMUM_BACKEND_VERSIONS[backendId]
  if (!minimum) return undefined
  const version = parseBackendVersion(rawVersion)
  // No readable version means the CLI answered in a shape we do not know. That
  // is worth saying, because it is also how a renamed or wrapped binary looks.
  if (!version) return `BOSS could not read a version from ${backendId}. It expects ${minimum} or newer.`
  if (isOlderThan(version, minimum)) {
    return `${backendId} ${version} is older than ${minimum}, the oldest version BOSS is tested against. Some features may not work until it is upgraded.`
  }
  return undefined
}
