export interface WorktreeInfo {
  id: string
  projectId: string
  projectPath: string
  path: string
  branch: string
  baseCommit: string
  ownerThreadId?: string
  createdAt: number
  lastUsedAt: number
  status: 'active' | 'removed'
  removedAt?: number
  copiedFiles: number
  /** Why the project's .worktreesetup failed, when it did. The worktree is
   *  still usable — a failed install does not make the checkout invalid — so
   *  this is reported rather than thrown. */
  setupError?: string
}

/** Where a thread's worktree is put.
 *
 *  'app-data' keeps them out of the project entirely, which is the safe
 *  default: nothing appears in the user's repository and nothing has to be
 *  ignored. The cost is that a worktree there cannot reach the project's
 *  node_modules, so a fresh one starts with nothing installed.
 *
 *  'project' puts them in .boss/worktrees inside the repository, where Node
 *  walks up and finds the parent's modules for free. That means an entry in
 *  the repository's local exclude file, which is why it is a choice rather
 *  than the default. */
export type WorktreeLocation = 'app-data' | 'project'

export interface WorktreeSettings {
  autoCleanupEnabled: boolean
  cleanupAfterDays: number
  location: WorktreeLocation
}

export interface WorktreeCleanupResult {
  removed: WorktreeInfo[]
  skipped: Array<{ worktree: WorktreeInfo; reason: string }>
}
