import { parseGitLog, parseGitBranches, parseGitStatusPorcelain, type StatusFile } from './diff'
import { gitStageArgs, gitUnstageArgs, stashRefForOid } from './git-commands'

export { gitStageArgs, gitUnstageArgs, planBranchSwitch, type BranchSwitchPlan } from './git-commands'

async function runGit(path: string, args: string[]): Promise<string> {
  const res = await window.boss.gitRun(path, args)
  if (res.code !== 0) throw new Error(res.stderr.trim() || res.stdout.trim() || `git ${args[0]} failed`)
  return res.stdout
}

export async function gitDiffFiles(path: string, scope: 'worktree' | 'staged' | 'compare', base?: string): Promise<string[]> {
  const args =
    scope === 'worktree'
      ? ['diff', '--name-only']
      : scope === 'staged'
        ? ['diff', '--cached', '--name-only']
        : ['diff', base ?? 'origin/main', '--name-only']
  return (await runGit(path, args)).split('\n').map((l) => l.trim()).filter(Boolean)
}

export async function gitFileDiff(path: string, scope: 'worktree' | 'staged' | 'compare', file: string, base?: string): Promise<string> {
  const args =
    scope === 'worktree'
      ? ['diff', '--', file]
      : scope === 'staged'
        ? ['diff', '--cached', '--', file]
        : ['diff', base ?? 'origin/main', '--', file]
  return runGit(path, args)
}

export async function gitLog(path: string): Promise<Array<{ sha: string; msg: string }>> {
  return parseGitLog(await runGit(path, ['log', '--oneline', '-20']))
}

export async function gitBranches(path: string): Promise<string[]> {
  const list = parseGitBranches(await runGit(path, ['branch', '--format=%(refname:short)']))
  const current = (await runGit(path, ['branch', '--show-current'])).trim()
  return list.filter((b) => b && b !== current)
}

export async function gitCurrentBranch(path: string): Promise<string> {
  return (await runGit(path, ['branch', '--show-current'])).trim()
}

export async function gitShow(path: string, sha: string, file?: string): Promise<string> {
  return file ? runGit(path, ['show', '--format=', sha, '--', file]) : runGit(path, ['show', '--format=', sha])
}

export async function gitCommitFiles(path: string, sha: string): Promise<string[]> {
  return (await runGit(path, ['diff-tree', '--no-commit-id', '--name-only', '-r', sha]))
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

export async function gitStatusFiles(path: string): Promise<StatusFile[]> {
  return parseGitStatusPorcelain(await runGit(path, ['status', '--porcelain=v1', '-z'])).files
}

export async function gitStage(path: string, files: StatusFile[]): Promise<void> {
  for (const args of gitStageArgs(files)) await runGit(path, args)
}

export async function gitUnstage(path: string, files: StatusFile[]): Promise<void> {
  const head = await window.boss.gitRun(path, ['rev-parse', '--verify', 'HEAD'])
  for (const args of gitUnstageArgs(files, head.code === 0)) await runGit(path, args)
}

export async function gitCheckout(path: string, branch: string): Promise<void> {
  await runGit(path, ['checkout', branch])
}

export async function gitCreateBranch(path: string, name: string): Promise<void> {
  await runGit(path, ['checkout', '-b', name])
}

async function gitStashHead(path: string): Promise<string | null> {
  const result = await window.boss.gitRun(path, ['rev-parse', '--verify', 'refs/stash'])
  return result.code === 0 ? result.stdout.trim() || null : null
}

export async function gitStashPush(path: string): Promise<string | null> {
  const before = await gitStashHead(path)
  await runGit(path, ['stash', 'push', '--include-untracked', '-m', 'BOSS branch switch'])
  const after = await gitStashHead(path)
  return after && after !== before ? after : null
}

export async function gitStashPop(path: string, oid: string): Promise<void> {
  const oids = (await runGit(path, ['stash', 'list', '--format=%H'])).split('\n').map((item) => item.trim()).filter(Boolean)
  const ref = stashRefForOid(oids, oid)
  if (!ref) throw new Error(`BOSS branch-switch stash ${oid.slice(0, 12)} is no longer available`)
  await runGit(path, ['stash', 'pop', ref])
}

/** Paths where `range` (e.g. `main..feature`) differs from HEAD. */
export async function gitChangedBetween(path: string, range: string): Promise<string[]> {
  return (await runGit(path, ['diff', '--name-only', '--no-renames', '-z', range])).split('\0').filter(Boolean)
}
