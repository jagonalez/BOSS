import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

export interface ProjectScope {
  projectId: string
  projectPath: string
  executionPath: string
}

export interface ProjectCheckout {
  path: string
  branch?: string
  main: boolean
}

function canonicalPath(path: string): string {
  if (!path) return ''
  const absolute = resolve(path)
  try {
    return realpathSync.native(absolute)
  } catch {
    return absolute
  }
}

function gitOutput(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: 2500,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return ''
  }
}

/** The repository metadata Git writes for a checkout.
 *
 * A linked worktree only has a small `.git` pointer inside the checkout. Its
 * index, objects, refs, and locks live in the main repository's common Git
 * directory, which is outside the checkout and therefore outside a sandbox
 * rooted at the checkout alone. Resolve this from the trusted project path so
 * a writable file inside a worktree cannot redirect the sandbox at an
 * arbitrary directory. */
export function gitCommonDirectory(projectPath: string): string | undefined {
  const value = gitOutput(projectPath, ['rev-parse', '--git-common-dir'])
  if (!value) return undefined
  return canonicalPath(isAbsolute(value) ? value : resolve(projectPath, value))
}

/** Writable roots for a thread scoped to one project checkout.
 *
 * Main checkouts already contain their Git directory, so they retain the
 * ordinary single workspace root. A linked worktree receives only its own
 * repository's common Git metadata as the additional root; no parent project
 * files or other checkout's working files are exposed. */
export function projectSandboxWritableRoots(projectPath: string, executionPath: string): string[] {
  const checkout = canonicalPath(executionPath)
  if (!checkout) return []
  const commonGit = gitCommonDirectory(projectPath)
  if (!commonGit) return [checkout]
  const fromCheckout = relative(checkout, commonGit)
  const alreadyInsideCheckout = fromCheckout === '' || (!fromCheckout.startsWith('..') && !isAbsolute(fromCheckout))
  return alreadyInsideCheckout ? [checkout] : [checkout, commonGit]
}

function mainWorktree(cwd: string): string {
  const output = gitOutput(cwd, ['worktree', 'list', '--porcelain', '-z'])
  const entry = output.split('\0').find((line) => line.startsWith('worktree '))
  return entry ? canonicalPath(entry.slice('worktree '.length)) : ''
}

export function projectCheckouts(path: string): ProjectCheckout[] {
  const executionPath = canonicalPath(path)
  if (!executionPath) return []
  const records = gitOutput(executionPath, ['worktree', 'list', '--porcelain', '-z'])
    .split('\0\0')
    .map((record) => record.split('\0').filter(Boolean))
    .filter((record) => record.some((line) => line.startsWith('worktree ')))
  return records.map((record, index) => {
    const worktree = record.find((line) => line.startsWith('worktree '))
    const branch = record.find((line) => line.startsWith('branch '))
    return {
      path: canonicalPath(worktree!.slice('worktree '.length)),
      branch: branch?.slice('branch refs/heads/'.length),
      main: index === 0
    }
  })
}

export function projectScope(path: string): ProjectScope {
  const executionPath = canonicalPath(path)
  if (!executionPath) return { projectId: 'global', projectPath: '', executionPath: '' }

  const commonDir = gitCommonDirectory(executionPath) ?? ''
  const projectPath = commonDir ? mainWorktree(executionPath) || executionPath : executionPath
  const identity = commonDir ? `git:${commonDir}` : `directory:${projectPath}`
  const digest = createHash('sha256').update(identity).digest('hex').slice(0, 24)
  return { projectId: `project_${digest}`, projectPath, executionPath }
}
