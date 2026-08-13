import { execFile } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import type { WorktreeCleanupResult, WorktreeInfo, WorktreeSettings } from '../shared/worktree'

interface WorktreeState {
  version: 1
  settings: WorktreeSettings
  worktrees: WorktreeInfo[]
}

interface WorktreeManagerOptions {
  stateFile: string
  root: string
}

const DEFAULT_SETTINGS: WorktreeSettings = {
  autoCleanupEnabled: true,
  cleanupAfterDays: 30
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolveGit, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || stdout).trim()
        reject(new Error(detail || error.message))
        return
      }
      resolveGit(String(stdout))
    })
  })
}

function slug(value: string): string {
  const clean = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36)
  return clean || 'thread'
}

function nullList(value: string): string[] {
  return value.split('\0').filter(Boolean)
}

function safeRelativePath(value: string): boolean {
  if (!value || isAbsolute(value) || value.includes('\0')) return false
  const clean = normalize(value)
  return clean !== '..' && !clean.startsWith(`..${sep}`)
}

export class WorktreeManager {
  private readonly options: WorktreeManagerOptions
  private loaded = false
  private state: WorktreeState = { version: 1, settings: { ...DEFAULT_SETTINGS }, worktrees: [] }

  constructor(options: WorktreeManagerOptions) {
    this.options = options
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed = JSON.parse(await readFile(this.options.stateFile, 'utf8')) as Partial<WorktreeState>
      if (parsed.version === 1) {
        this.state = {
          version: 1,
          settings: { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) },
          worktrees: Array.isArray(parsed.worktrees) ? parsed.worktrees : []
        }
      }
    } catch {
      /* First launch starts with safe defaults. */
    }
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.options.stateFile), { recursive: true })
    await writeFile(this.options.stateFile, JSON.stringify(this.state, null, 2))
  }

  async settings(): Promise<WorktreeSettings> {
    await this.load()
    return { ...this.state.settings }
  }

  async setSettings(patch: Partial<WorktreeSettings>): Promise<WorktreeSettings> {
    await this.load()
    const days = patch.cleanupAfterDays === undefined
      ? this.state.settings.cleanupAfterDays
      : Math.max(1, Math.min(365, Math.round(patch.cleanupAfterDays)))
    this.state.settings = {
      autoCleanupEnabled: patch.autoCleanupEnabled ?? this.state.settings.autoCleanupEnabled,
      cleanupAfterDays: days
    }
    await this.save()
    return { ...this.state.settings }
  }

  async list(projectId?: string): Promise<WorktreeInfo[]> {
    await this.load()
    return this.state.worktrees
      .filter((item) => !projectId || item.projectId === projectId)
      .map((item) => ({ ...item }))
  }

  private async copyIncludedIgnoredFiles(projectPath: string, worktreePath: string): Promise<number> {
    const includeFile = join(projectPath, '.worktreeinclude')
    try {
      await lstat(includeFile)
    } catch {
      return 0
    }

    const [ignoredOutput, includedOutput] = await Promise.all([
      git(projectPath, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']),
      git(projectPath, ['ls-files', '--others', '--ignored', '--exclude-from=.worktreeinclude', '-z'])
    ])
    const ignored = new Set(nullList(ignoredOutput))
    const selected = nullList(includedOutput).filter((path) => ignored.has(path) && safeRelativePath(path))
    if (selected.length > 5_000) throw new Error('.worktreeinclude matched more than 5,000 files; narrow its patterns first.')

    let copied = 0
    for (const path of selected) {
      const source = resolve(projectPath, path)
      const target = resolve(worktreePath, path)
      if (relative(projectPath, source).startsWith('..') || relative(worktreePath, target).startsWith('..')) continue
      const stat = await lstat(source)
      if (!stat.isFile() || stat.isSymbolicLink()) continue
      await mkdir(dirname(target), { recursive: true })
      await copyFile(source, target)
      copied += 1
    }
    return copied
  }

  async create(input: {
    projectId: string
    projectPath: string
    sourcePath: string
    title?: string
    ownerThreadId?: string
  }): Promise<WorktreeInfo> {
    await this.load()
    if (!input.projectPath || input.projectId === 'global') throw new Error('Global chats cannot create Git worktrees.')
    const repoRoot = (await git(input.projectPath, ['rev-parse', '--show-toplevel'])).trim()
    const sourceRoot = (await git(input.sourcePath || input.projectPath, ['rev-parse', '--show-toplevel'])).trim()
    const baseCommit = (await git(sourceRoot, ['rev-parse', 'HEAD'])).trim()
    const id = randomUUID()
    const shortId = id.slice(0, 8)
    const name = slug(input.title ?? 'thread')
    const branch = `boss/${name}-${shortId}`
    const repoKey = `${slug(basename(repoRoot))}-${createHash('sha256').update(repoRoot).digest('hex').slice(0, 8)}`
    const worktreePath = join(this.options.root, repoKey, `${name}-${shortId}`)
    await mkdir(dirname(worktreePath), { recursive: true })
    await git(repoRoot, ['worktree', 'add', '-b', branch, worktreePath, baseCommit])

    let copiedFiles = 0
    try {
      copiedFiles = await this.copyIncludedIgnoredFiles(repoRoot, worktreePath)
    } catch (error) {
      await git(repoRoot, ['worktree', 'remove', worktreePath]).catch(() => {})
      throw error
    }

    const timestamp = Date.now()
    const info: WorktreeInfo = {
      id,
      projectId: input.projectId,
      projectPath: repoRoot,
      path: worktreePath,
      branch,
      baseCommit,
      ownerThreadId: input.ownerThreadId,
      createdAt: timestamp,
      lastUsedAt: timestamp,
      status: 'active',
      copiedFiles
    }
    this.state.worktrees.push(info)
    await this.save()
    return { ...info }
  }

  async setOwner(id: string, ownerThreadId: string): Promise<void> {
    await this.load()
    const item = this.state.worktrees.find((worktree) => worktree.id === id)
    if (!item) return
    item.ownerThreadId = ownerThreadId
    item.lastUsedAt = Date.now()
    await this.save()
  }

  async touch(id: string): Promise<void> {
    await this.load()
    const item = this.state.worktrees.find((worktree) => worktree.id === id && worktree.status === 'active')
    if (!item) return
    item.lastUsedAt = Date.now()
    await this.save()
  }

  async remove(id: string): Promise<WorktreeInfo> {
    await this.load()
    const item = this.state.worktrees.find((worktree) => worktree.id === id)
    if (!item) throw new Error('BOSS worktree not found.')
    if (item.status === 'removed') return { ...item }
    const status = await git(item.path, ['status', '--porcelain', '--untracked-files=all'])
    if (status.trim()) throw new Error('This worktree has uncommitted or untracked changes and was not removed.')
    await git(item.projectPath, ['worktree', 'remove', item.path])
    item.status = 'removed'
    item.removedAt = Date.now()
    await this.save()
    return { ...item }
  }

  async cleanup(now = Date.now()): Promise<WorktreeCleanupResult> {
    await this.load()
    const result: WorktreeCleanupResult = { removed: [], skipped: [] }
    if (!this.state.settings.autoCleanupEnabled) return result
    const cutoff = now - this.state.settings.cleanupAfterDays * 24 * 60 * 60 * 1_000
    for (const item of this.state.worktrees.filter((worktree) => worktree.status === 'active' && worktree.lastUsedAt < cutoff)) {
      try {
        result.removed.push(await this.remove(item.id))
      } catch (error) {
        result.skipped.push({ worktree: { ...item }, reason: error instanceof Error ? error.message : String(error) })
      }
    }
    return result
  }
}
