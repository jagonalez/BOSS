import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error Application code uses bundler resolution.
import { ReviewManager, noChangeRequestYet } from './review-manager.ts'
import type { ReviewProvider, ReviewProviderMatch, ReviewRepository } from './review-provider.ts'
import type { AddReviewCommentInput, ChangeRequestFileDiff, ChangeRequestSummary } from '../shared/review.ts'

class FakeForgeProvider implements ReviewProvider {
  readonly summary = {
    id: 'fake-forge',
    label: 'Fake Forge',
    changeRequestLabel: 'Merge proposal',
    capabilities: {
      canonicalDiff: true,
      publishOverallComment: true,
      publishInlineComment: false,
      replyToComment: false,
      submitVerdict: false
    }
  }

  match(remoteUrl: string): ReviewProviderMatch | undefined {
    return remoteUrl.includes('fake.test') ? { repository: 'group/repo' } : undefined
  }

  async getChangeRequest(): Promise<ChangeRequestSummary> {
    return {
      providerId: this.summary.id,
      repository: 'group/repo',
      id: '42',
      displayId: '!42',
      title: 'Provider boundary',
      url: 'https://fake.test/group/repo/reviews/42',
      state: 'OPEN',
      isDraft: false,
      author: { login: 'reviewer' },
      baseRefName: 'main',
      baseRefOid: 'base',
      headRefName: 'feature',
      headRefOid: 'head',
      checks: [],
      reviews: [],
      comments: []
    }
  }

  async getCanonicalDiff(): Promise<ChangeRequestFileDiff[]> { return [] }
  async publishComment(_repository: ReviewRepository, _match: ReviewProviderMatch, _changeRequest: ChangeRequestSummary, _input: AddReviewCommentInput): Promise<void> {}
}

test('persists checkout-specific local review comments', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'boss-review-'))
  const stateFile = join(directory, 'comments.json')
  const repository = join(directory, 'repo')
  try {
    execFileSync('git', ['init', repository])
    execFileSync('git', ['-C', repository, 'config', 'user.email', 'boss@example.test'])
    execFileSync('git', ['-C', repository, 'config', 'user.name', 'BOSS Test'])
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

test('review manager selects providers without knowing forge-specific semantics', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'boss-review-provider-'))
  const repository = join(directory, 'repo')
  try {
    execFileSync('git', ['init', repository])
    execFileSync('git', ['-C', repository, 'config', 'user.email', 'boss@example.test'])
    execFileSync('git', ['-C', repository, 'config', 'user.name', 'BOSS Test'])
    execFileSync('git', ['-C', repository, 'config', 'commit.gpgsign', 'false'])
    writeFileSync(join(repository, 'file.ts'), 'export const value = 1\n')
    execFileSync('git', ['-C', repository, 'add', 'file.ts'])
    execFileSync('git', ['-C', repository, 'commit', '-m', 'initial'])
    execFileSync('git', ['-C', repository, 'remote', 'add', 'origin', 'https://fake.test/group/repo.git'])

    const manager = new ReviewManager(join(directory, 'comments.json'), [new FakeForgeProvider()])
    const snapshot = await manager.snapshot(repository)
    assert.equal(snapshot.provider?.id, 'fake-forge')
    assert.equal(snapshot.provider?.changeRequestLabel, 'Merge proposal')
    assert.equal(snapshot.changeRequest?.displayId, '!42')
    await assert.rejects(
      manager.publishComment(repository, { body: 'Inline', file: 'file.ts', line: 1, side: 'RIGHT' }),
      /does not support this kind of review comment/
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a branch with no change request yet is not an error', () => {
  // The exact text `gh pr view` writes to stderr and exits 1 on.
  assert.equal(noChangeRequestYet('no pull requests found for branch "no-ticket/chat-emoji-clean"'), true)
  assert.equal(noChangeRequestYet('no merge requests found for branch "topic"'), true)

  // A lookup that actually broke still has to reach the user.
  for (const real of [
    'gh: command not found',
    'HTTP 401: Bad credentials',
    'could not determine current branch',
    'failed to run git: not a git repository'
  ]) {
    assert.equal(noChangeRequestYet(real), false, `${real} is a real failure`)
  }
})

test('a stale or non-Git checkout returns an unavailable snapshot instead of rejecting IPC', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'boss-review-unavailable-'))
  const plainDirectory = join(directory, 'plain-folder')
  mkdirSync(plainDirectory)
  try {
    const manager = new ReviewManager(join(directory, 'comments.json'))
    for (const checkout of [plainDirectory, join(directory, 'deleted-worktree')]) {
      const snapshot = await manager.snapshot(checkout)
      assert.equal(snapshot.repositoryRoot, checkout)
      assert.equal(snapshot.branch, '')
      assert.deepEqual(snapshot.localComments, [])
      assert.match(snapshot.syncError ?? '', /git rev-parse|not a git repository/i)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the snapshot reports a missing change request without a sync error', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'boss-review-empty-'))
  const repository = join(directory, 'repo')
  try {
    execFileSync('git', ['init', repository])
    execFileSync('git', ['-C', repository, 'remote', 'add', 'origin', 'https://fake.test/group/repo.git'])

    class NoChangeRequestProvider extends FakeForgeProvider {
      async getChangeRequest(): Promise<ChangeRequestSummary> {
        throw new Error('no pull requests found for branch "topic"')
      }
    }

    const manager = new ReviewManager(join(directory, 'comments.json'), [new NoChangeRequestProvider()])
    const snapshot = await manager.snapshot(repository)

    // The provider was found and works. There is simply nothing to review yet,
    // so warning about the checkout would be wrong.
    assert.equal(snapshot.provider?.id, 'fake-forge')
    assert.equal(snapshot.awaitingChangeRequest, true)
    assert.equal(snapshot.syncError, undefined)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('two threads on one branch look the change request up once', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'boss-review-shared-'))
  const repository = join(directory, 'repo')
  try {
    execFileSync('git', ['init', repository])
    execFileSync('git', ['-C', repository, 'remote', 'add', 'origin', 'https://fake.test/group/repo.git'])

    let lookups = 0
    class CountingProvider extends FakeForgeProvider {
      async getChangeRequest(...args: Parameters<FakeForgeProvider['getChangeRequest']>): Promise<ChangeRequestSummary> {
        lookups += 1
        return super.getChangeRequest(...args)
      }
    }

    const manager = new ReviewManager(join(directory, 'comments.json'), [new CountingProvider()])
    // The review tab asking, then the sidebar asking for the same branch.
    await manager.snapshot(repository)
    const second = await manager.snapshot(repository)

    assert.equal(second.changeRequest?.displayId, '!42')
    assert.equal(lookups, 1, 'the second ask should be served from the cache')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a real sync failure is still reported', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'boss-review-broken-'))
  const repository = join(directory, 'repo')
  try {
    execFileSync('git', ['init', repository])
    execFileSync('git', ['-C', repository, 'remote', 'add', 'origin', 'https://fake.test/group/repo.git'])

    class BrokenProvider extends FakeForgeProvider {
      async getChangeRequest(): Promise<ChangeRequestSummary> {
        throw new Error('HTTP 401: Bad credentials')
      }
    }

    const manager = new ReviewManager(join(directory, 'comments.json'), [new BrokenProvider()])
    const snapshot = await manager.snapshot(repository)

    assert.equal(snapshot.syncError, 'HTTP 401: Bad credentials')
    assert.equal(snapshot.awaitingChangeRequest, undefined)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
