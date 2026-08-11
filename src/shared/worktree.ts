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
}

export interface WorktreeSettings {
  autoCleanupEnabled: boolean
  cleanupAfterDays: number
}

export interface WorktreeCleanupResult {
  removed: WorktreeInfo[]
  skipped: Array<{ worktree: WorktreeInfo; reason: string }>
}
