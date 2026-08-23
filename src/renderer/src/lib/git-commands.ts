import type { StatusFile } from './diff'

/** One `git add -- <path>` per file. Plain add covers modified, new and deleted
 *  paths alike — git 2.x stages a working-tree removal for a tracked path the
 *  same as an edit — and both sides of a rename, so the index records the move
 *  rather than losing half of it. */
export function gitStageArgs(files: StatusFile[]): string[][] {
  return files.map((file) => ['add', '--', ...renameSides(file)])
}

/** One unstage command per status entry, naming both sides of a rename. Before
 *  the first commit there is no HEAD for restore to read, so cached removal is
 *  the equivalent operation. */
export function gitUnstageArgs(files: StatusFile[], hasHead = true): string[][] {
  return files.map((file) => hasHead
    ? ['restore', '--staged', '--', ...renameSides(file)]
    : ['rm', '--cached', '--ignore-unmatch', '--', ...renameSides(file)])
}

function renameSides(file: StatusFile): string[] {
  return file.oldPath ? [file.oldPath, file.path] : [file.path]
}

export interface BranchSwitchPlan {
  action: 'direct' | 'stash' | 'block'
  /** Paths only the target branch changes; shown when a switch is blocked. */
  conflicts?: string[]
}

/** Decide how a checkout onto `target` may proceed.
 *
 *  A clean tree just switches. A dirty one is stashed (untracked files
 *  included) and popped afterwards, but only when nothing lying locally —
 *  edited or untracked — is also different on the target branch. An edit that
 *  overlaps would conflict on pop and strand the work mid-switch; an untracked
 *  file would make checkout refuse outright. Either way the switch is blocked
 *  and the offending paths named instead. */
export function planBranchSwitch(localChanges: string[], untracked: string[], targetChanges: string[]): BranchSwitchPlan {
  const all = [...localChanges, ...untracked]
  if (all.length === 0) return { action: 'direct' }
  const overlapping = all.filter((local) => targetChanges.some((target) => pathsCollide(local, target)))
  if (overlapping.length > 0) return { action: 'block', conflicts: overlapping }
  return { action: 'stash' }
}

function pathsCollide(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

/** Resolve a captured stash commit to its current reflog selector. Other Git
 *  clients may add stashes while a switch is running, so stash@{0} is not a
 *  stable identity. */
export function stashRefForOid(stashOids: string[], oid: string): string | null {
  const index = stashOids.indexOf(oid)
  return index < 0 ? null : `stash@{${index}}`
}
