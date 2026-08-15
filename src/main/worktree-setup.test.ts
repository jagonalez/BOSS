import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error Application code uses bundler resolution.
import { WorktreeManager } from './worktree-manager.ts'

function repo(): { dir: string; root: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'boss-worktree-setup-'))
  const root = join(dir, 'repo')
  execFileSync('git', ['init', '-b', 'main', root])
  execFileSync('git', ['-C', root, 'config', 'user.email', 'boss@example.test'])
  execFileSync('git', ['-C', root, 'config', 'user.name', 'BOSS Test'])
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false'])
  writeFileSync(join(root, 'file.ts'), 'export const value = 1\n')
  execFileSync('git', ['-C', root, 'add', 'file.ts'])
  execFileSync('git', ['-C', root, 'commit', '-m', 'initial'])
  return { dir, root, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function manager(dir: string): WorktreeManager {
  return new WorktreeManager({ stateFile: join(dir, 'worktrees.json'), root: join(dir, 'worktrees') })
}

test('a project setup script runs in the new worktree', async () => {
  // Copying files gets a worktree its .env; it cannot get it node_modules.
  const { dir, root, cleanup } = repo()
  try {
    writeFileSync(join(root, '.worktreesetup'), '#!/bin/sh\necho installed > installed.txt\n')
    const created = await manager(dir).create({ projectId: 'p', projectPath: root, sourcePath: root, title: 'setup' })

    assert.ok(existsSync(join(created.path, 'installed.txt')), 'the script should have run in the worktree')
    assert.equal(readFileSync(join(created.path, 'installed.txt'), 'utf8').trim(), 'installed')
    assert.equal(created.setupError, undefined)
  } finally {
    cleanup()
  }
})

test('a script is told which worktree and which project it is in', async () => {
  // So it can copy from the checkout it came from without working out which.
  const { dir, root, cleanup } = repo()
  try {
    writeFileSync(join(root, '.worktreesetup'), '#!/bin/sh\nprintf "%s\\n%s\\n" "$BOSS_WORKTREE_PATH" "$BOSS_PROJECT_PATH" > env.txt\n')
    const created = await manager(dir).create({ projectId: 'p', projectPath: root, sourcePath: root, title: 'env' })

    const [worktreePath, projectPath] = readFileSync(join(created.path, 'env.txt'), 'utf8').trim().split('\n')
    assert.equal(worktreePath, created.path)
    // realpath, because the manager resolves the repository root through git
    // and macOS reports /tmp as /private/tmp.
    assert.equal(projectPath, realpathSync(root))
  } finally {
    cleanup()
  }
})

test('a failed script is reported and the worktree is kept', async () => {
  // A failed install does not make a checkout invalid, and discarding it would
  // take the branch with it.
  const { dir, root, cleanup } = repo()
  try {
    writeFileSync(join(root, '.worktreesetup'), '#!/bin/sh\necho "npm ERR! could not resolve" >&2\nexit 1\n')
    const created = await manager(dir).create({ projectId: 'p', projectPath: root, sourcePath: root, title: 'fails' })

    assert.ok(created.setupError, 'the failure should be reported')
    assert.match(created.setupError!, /could not resolve/)
    assert.ok(existsSync(join(created.path, 'file.ts')), 'the worktree should still be there')
  } finally {
    cleanup()
  }
})

test('a project with no script is untouched', async () => {
  const { dir, root, cleanup } = repo()
  try {
    const created = await manager(dir).create({ projectId: 'p', projectPath: root, sourcePath: root, title: 'none' })
    assert.equal(created.setupError, undefined)
    assert.ok(existsSync(join(created.path, 'file.ts')))
  } finally {
    cleanup()
  }
})

test('a script does not need its executable bit', async () => {
  // It is run through /bin/sh, so a file checked out without the bit — which
  // is what git does on some setups — still works.
  const { dir, root, cleanup } = repo()
  try {
    const script = join(root, '.worktreesetup')
    writeFileSync(script, '#!/bin/sh\ntouch ran.txt\n')
    chmodSync(script, 0o644)
    const created = await manager(dir).create({ projectId: 'p', projectPath: root, sourcePath: root, title: 'noexec' })

    assert.ok(existsSync(join(created.path, 'ran.txt')))
    assert.equal(created.setupError, undefined)
  } finally {
    cleanup()
  }
})
