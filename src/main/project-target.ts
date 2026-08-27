import { basename, isAbsolute, resolve } from 'node:path'

/** Find a project the user has already opened by its full path or folder name.
 *
 * Kept separate from projectScope's filesystem canonicalisation so the human
 * shorthand is deterministic and directly testable. The manager resolves the
 * returned path to a repository identity before creating anything. */
export function knownProjectCandidates(requested: string, knownPaths: string[]): string[] {
  const target = requested.trim()
  if (!target) return []
  const exact = isAbsolute(target) ? knownPaths.filter((path) => resolve(path) === resolve(target)) : []
  if (exact.length) return exact
  const name = target.toLocaleLowerCase()
  return knownPaths.filter((path) => basename(path).toLocaleLowerCase() === name)
}
