import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Node's type-stripping test runner needs the extension.
import { parseGitHubPullRequests } from './lab-assistant-github.ts'

test('GitHub PR refresh data maps to authoritative assistant observations', () => {
  const pullRequests = parseGitHubPullRequests(JSON.stringify([
    {
      number: 22,
      title: 'Dependent change',
      url: 'https://github.com/jagonalez/BOSS/pull/22',
      headRefName: 'feature-22',
      baseRefName: 'main',
      mergeable: 'CONFLICTING'
    },
    {
      number: 23,
      title: 'Independent change',
      url: 'https://github.com/jagonalez/BOSS/pull/23',
      headRefName: 'feature-23',
      baseRefName: 'main',
      mergeable: 'MERGEABLE'
    }
  ]), 'jagonalez/BOSS', 123)
  assert.equal(pullRequests.length, 2)
  assert.equal(pullRequests[0].mergeability, 'conflicted')
  assert.equal(pullRequests[1].mergeability, 'clean')
  assert.equal(pullRequests[0].updatedAt, 123)
})

test('malformed GitHub PR refresh data is ignored', () => {
  assert.deepEqual(parseGitHubPullRequests('not json', 'jagonalez/BOSS'), [])
  assert.deepEqual(parseGitHubPullRequests('[{"number":1}]', 'jagonalez/BOSS'), [])
})
