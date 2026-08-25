import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error Application code uses bundler resolution.
import { gitCommonDirectory, projectCheckouts, projectSandboxWritableRoots, projectScope } from './project-identity.ts'

test('linked worktrees share one project while retaining their checkout paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'boss-project-identity-'))
  const repository = join(root, 'repository')
  const linked = join(root, 'linked')
  try {
    execFileSync('git', ['init', '-b', 'main', repository])
    execFileSync('git', ['-C', repository, 'config', 'user.name', 'BOSS Test'])
    execFileSync('git', ['-C', repository, 'config', 'user.email', 'boss@example.test'])
    execFileSync('git', ['-C', repository, 'config', 'commit.gpgsign', 'false'])
    execFileSync('git', ['-C', repository, 'commit', '--allow-empty', '-m', 'initial'])
    execFileSync('git', ['-C', repository, 'worktree', 'add', '-b', 'feature/review', linked])

    const mainScope = projectScope(repository)
    const linkedScope = projectScope(linked)
    assert.equal(linkedScope.projectId, mainScope.projectId)
    assert.equal(linkedScope.projectPath, realpathSync.native(repository))
    assert.equal(linkedScope.executionPath, realpathSync.native(linked))

    const commonGit = realpathSync.native(join(repository, '.git'))
    assert.equal(gitCommonDirectory(repository), commonGit)
    assert.deepEqual(
      projectSandboxWritableRoots(repository, repository),
      [realpathSync.native(repository)],
      'a main checkout already contains its Git metadata'
    )
    assert.deepEqual(
      projectSandboxWritableRoots(repository, linked),
      [realpathSync.native(linked), commonGit],
      'a linked checkout needs its trusted common Git directory for index, object, and ref locks'
    )

    assert.deepEqual(projectCheckouts(linked), [
      { path: realpathSync.native(repository), branch: 'main', main: true },
      { path: realpathSync.native(linked), branch: 'feature/review', main: false }
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
