import assert from 'node:assert/strict'
import test from 'node:test'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error Application code uses bundler resolution.
import { GitHubReviewProvider, parseGitHubRemote, splitGitHubPullRequestDiff } from './github-review-provider.ts'

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
  const files = splitGitHubPullRequestDiff([
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

test('declares GitHub-specific review capabilities', () => {
  const provider = new GitHubReviewProvider()
  assert.equal(provider.summary.id, 'github')
  assert.equal(provider.summary.changeRequestLabel, 'Pull request')
  assert.equal(provider.summary.capabilities.publishInlineComment, true)
})
