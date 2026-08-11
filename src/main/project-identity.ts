import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

export interface ProjectScope {
  projectId: string
  projectPath: string
  executionPath: string
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

function mainWorktree(cwd: string): string {
  const output = gitOutput(cwd, ['worktree', 'list', '--porcelain', '-z'])
  const entry = output.split('\0').find((line) => line.startsWith('worktree '))
  return entry ? canonicalPath(entry.slice('worktree '.length)) : ''
}

export function projectScope(path: string): ProjectScope {
  const executionPath = canonicalPath(path)
  if (!executionPath) return { projectId: 'global', projectPath: '', executionPath: '' }

  const commonDirValue = gitOutput(executionPath, ['rev-parse', '--git-common-dir'])
  const commonDir = commonDirValue
    ? canonicalPath(isAbsolute(commonDirValue) ? commonDirValue : resolve(executionPath, commonDirValue))
    : ''
  const projectPath = commonDir ? mainWorktree(executionPath) || executionPath : executionPath
  const identity = commonDir ? `git:${commonDir}` : `directory:${projectPath}`
  const digest = createHash('sha256').update(identity).digest('hex').slice(0, 24)
  return { projectId: `project_${digest}`, projectPath, executionPath }
}
