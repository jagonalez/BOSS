import type { StatusFile } from './diff'

/** One `git add -- <path>` per file. Plain add covers modified, new and deleted
 *  paths alike — git 2.x stages a working-tree removal for a tracked path the
 *  same as an edit — and both sides of a rename, so the index records the move
 *  rather than losing half of it. */
export function gitStageArgs(files: StatusFile[]): string[][] {
  return files.map((file) => ['add', '--', ...renameSides(file)])
}

/** One `git restore --staged -- <path>` per side. A path can be missing from
 *  HEAD (the new half of a rename), so sides go one command each and a miss on
 *  one does not take the other down with it. */
export function gitUnstageArgs(files: StatusFile[]): string[][] {
  return files.map((file) => ['restore', '--staged', '--', ...renameSides(file)])
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
  const differing = new Set(targetChanges)
  const overlapping = all.filter((p) => differing.has(p))
  if (overlapping.length > 0) return { action: 'block', conflicts: overlapping }
  return { action: 'stash' }
}
