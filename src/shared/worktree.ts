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

export interface WorktreeSettings {
  autoCleanupEnabled: boolean
  cleanupAfterDays: number
}

export interface WorktreeCleanupResult {
  removed: WorktreeInfo[]
  skipped: Array<{ worktree: WorktreeInfo; reason: string }>
}
