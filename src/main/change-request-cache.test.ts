import assert from 'node:assert/strict'
import test from 'node:test'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error Application code uses bundler resolution.
import { ChangeRequestCache, changeRequestKey } from './change-request-cache.ts'
import type { ChangeRequestSummary } from '../shared/review.ts'

const summary = (id: string): ChangeRequestSummary => ({
  providerId: 'github',
  repository: 'owner/repo',
  id,
  displayId: `#${id}`,
  title: 'A change',
  url: `https://github.test/owner/repo/pull/${id}`,
  state: 'OPEN',
  isDraft: false,
  author: { login: 'someone' },
  baseRefName: 'main',
  baseRefOid: 'abc',
  headRefName: 'topic',
  headRefOid: 'def',
  checks: [],
  reviews: [],
  comments: []
})

test('a branch is looked up once, then reused', async () => {
  const cache = new ChangeRequestCache()
  let lookups = 0
  const fetch = async (): Promise<ChangeRequestSummary> => { lookups += 1; return summary('1') }

  const first = await cache.get('repo main', fetch)
  const second = await cache.get('repo main', fetch)

  assert.equal(first?.id, '1')
  assert.equal(second?.id, '1')
  assert.equal(lookups, 1, 'the second ask should not reach the provider')
})

test('a branch with no change request is remembered too', async () => {
  // The common case. Re-asking on every hover is the cost this exists to avoid.
  const cache = new ChangeRequestCache()
  let lookups = 0
  const fetch = async (): Promise<undefined> => { lookups += 1; return undefined }

  assert.equal(await cache.get('repo topic', fetch), undefined)
  assert.equal(await cache.get('repo topic', fetch), undefined)
  assert.equal(lookups, 1)
})

test('concurrent asks share one lookup', async () => {
  const cache = new ChangeRequestCache()
  let lookups = 0
  let release: (value: ChangeRequestSummary) => void = () => {}
  const fetch = (): Promise<ChangeRequestSummary> => {
    lookups += 1
    return new Promise((resolve) => { release = resolve })
  }

  // Two hovers a moment apart, before the first has answered.
  const both = Promise.all([cache.get('repo main', fetch), cache.get('repo main', fetch)])
  release(summary('7'))
  const [first, second] = await both

  assert.equal(lookups, 1, 'the second ask should join the first')
  assert.equal(first?.id, '7')
  assert.equal(second?.id, '7')
})

test('a stale entry is looked up again', async () => {
  let clock = 1_000
  const cache = new ChangeRequestCache({ now: () => clock, ttl: 60_000 })
  let lookups = 0
  const fetch = async (): Promise<ChangeRequestSummary> => { lookups += 1; return summary(String(lookups)) }

  await cache.get('repo main', fetch)
  clock += 59_000
  await cache.get('repo main', fetch)
  assert.equal(lookups, 1, 'still fresh')

  clock += 2_000
  const after = await cache.get('repo main', fetch)
  assert.equal(lookups, 2, 'past the ttl, ask again')
  assert.equal(after?.id, '2')
})

test('a failed lookup is not remembered as an answer', async () => {
  // A lookup that broke says nothing about whether a pull request exists.
  // Caching the failure would hide the pull request until the ttl ran out.
  const cache = new ChangeRequestCache()
  let lookups = 0
  const fetch = async (): Promise<ChangeRequestSummary> => {
    lookups += 1
    if (lookups === 1) throw new Error('HTTP 401: Bad credentials')
    return summary('9')
  }

  await assert.rejects(cache.get('repo main', fetch), /Bad credentials/)
  const second = await cache.get('repo main', fetch)

  assert.equal(second?.id, '9', 'the retry should reach the provider')
  assert.equal(lookups, 2)
})

test('invalidating drops what we know', async () => {
  const cache = new ChangeRequestCache()
  let lookups = 0
  const fetch = async (): Promise<ChangeRequestSummary> => { lookups += 1; return summary(String(lookups)) }

  await cache.get('repo main', fetch)
  await cache.get('repo topic', fetch)
  assert.equal(lookups, 2)

  cache.invalidate('repo main')
  await cache.get('repo main', fetch)
  assert.equal(lookups, 3, 'the dropped branch is looked up again')
  await cache.get('repo topic', fetch)
  assert.equal(lookups, 3, 'the other branch is untouched')

  cache.invalidate()
  await cache.get('repo topic', fetch)
  assert.equal(lookups, 4, 'dropping everything clears the rest')
})

test('a worktree and its parent share one entry', () => {
  // Same repository, same branch, same pull request. Keying on the checkout
  // path would look them up twice and show two answers for one thing.
  assert.equal(changeRequestKey('/src/ralf', 'main'), changeRequestKey('/src/ralf', 'main'))
  assert.notEqual(changeRequestKey('/src/ralf', 'main'), changeRequestKey('/src/ralf', 'topic'))
  assert.notEqual(changeRequestKey('/src/other', 'main'), changeRequestKey('/src/ralf', 'main'))
})
