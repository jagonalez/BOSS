import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error Application code uses bundler resolution.
import { parseGitHubRemote, ReviewManager, splitPullRequestDiff } from './review-manager.ts'

test('recognizes common GitHub remote formats', () => {
  assert.equal(parseGitHubRemote('git@github.com:openai/codex.git'), 'openai/codex')
  assert.equal(parseGitHubRemote('https://github.com/openai/codex.git'), 'openai/codex')
  assert.equal(parseGitHubRemote('ssh://git@github.com/openai/codex'), 'openai/codex')
})

test('does not treat other forges as GitHub', () => {
  assert.equal(parseGitHubRemote('git@gitlab.com:openai/codex.git'), undefined)
  assert.equal(parseGitHubRemote('https://example.com/openai/codex.git'), undefined)
})

test('splits the canonical pull request patch into files', () => {
  const files = splitPullRequestDiff([
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    'diff --git a/src/b.ts b/src/b.ts',
    '--- a/src/b.ts',
    '+++ b/src/b.ts',
    '@@ -0,0 +1 @@',
    '+added',
    'diff --git a/src/deleted.ts b/src/deleted.ts',
    'deleted file mode 100644',
    '--- a/src/deleted.ts',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-gone'
  ].join('\n'))
  assert.deepEqual(files.map((file) => file.path), ['src/a.ts', 'src/b.ts', 'src/deleted.ts'])
  assert.match(files[1].patch, /\+added/)
})

test('persists checkout-specific local review comments', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ralf-review-'))
  const stateFile = join(directory, 'comments.json')
  const repository = join(directory, 'repo')
  try {
    execFileSync('git', ['init', repository])
    execFileSync('git', ['-C', repository, 'config', 'user.email', 'ralf@example.test'])
    execFileSync('git', ['-C', repository, 'config', 'user.name', 'R.A.L.F. Test'])
    execFileSync('git', ['-C', repository, 'config', 'commit.gpgsign', 'false'])
    writeFileSync(join(repository, 'file.ts'), 'export const value = 1\n')
    execFileSync('git', ['-C', repository, 'add', 'file.ts'])
    execFileSync('git', ['-C', repository, 'commit', '-m', 'initial'])

    const manager = new ReviewManager(stateFile)
    const comment = await manager.addLocal(repository, {
      body: 'Check this boundary.', file: 'file.ts', line: 1, side: 'RIGHT'
    })
    assert.equal(comment.source, 'local')
    assert.equal((await manager.snapshot(repository)).localComments.length, 1)

    const restarted = new ReviewManager(stateFile)
    assert.equal((await restarted.snapshot(repository)).localComments[0]?.body, 'Check this boundary.')
    assert.equal(await restarted.deleteLocal(repository, comment.id), true)
    assert.equal((await restarted.snapshot(repository)).localComments.length, 0)
    assert.doesNotThrow(() => JSON.parse(readFileSync(stateFile, 'utf8')))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
