import assert from 'node:assert/strict'
import test from 'node:test'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error Application code uses bundler resolution.
import { GitHubReviewProvider, createChangeRequestArgs, parseGitHubRemote, splitGitHubPullRequestDiff } from './github-review-provider.ts'
// @ts-expect-error Application code uses bundler resolution.
import { changeRequestNumberFromUrl, firstUrl } from './review-provider.ts'

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

test('builds a create invocation that carries the body on standard input', () => {
  const { args, stdin } = createChangeRequestArgs({ title: 'Fix the thing', body: 'Line one\n\n`code` and "quotes"' }, 'fix/thing')
  assert.deepEqual(args, ['pr', 'create', '--head', 'fix/thing', '--title', 'Fix the thing', '--body-file', '-'])
  // The body must arrive byte-for-byte: it is prose, and a flag would have to quote it.
  assert.equal(stdin, 'Line one\n\n`code` and "quotes"')
})

test('asks the forge to fill a request that carries neither title nor body', () => {
  const { args, stdin } = createChangeRequestArgs({}, 'fix/thing')
  assert.deepEqual(args, ['pr', 'create', '--head', 'fix/thing', '--fill'])
  assert.equal(stdin, undefined)
})

test('never leaves gh to prompt for the half of the pair it was not given', () => {
  // gh prompts for a missing title or body, and a prompt in a spawned process hangs.
  const titleOnly = createChangeRequestArgs({ title: 'Only a title' }, 'fix/thing')
  assert.ok(titleOnly.args.includes('--body-file'))
  assert.equal(titleOnly.stdin, '')

  const bodyOnly = createChangeRequestArgs({ body: 'Only a body' }, 'fix/thing')
  assert.ok(bodyOnly.args.includes('--title'))
  // Falls back to the branch name rather than prompting.
  assert.equal(bodyOnly.args[bodyOnly.args.indexOf('--title') + 1], 'fix/thing')
})

test('passes base and draft through when asked', () => {
  const { args } = createChangeRequestArgs({ title: 't', body: 'b', baseBranch: 'develop', draft: true }, 'fix/thing')
  assert.equal(args[args.indexOf('--base') + 1], 'develop')
  assert.ok(args.includes('--draft'))
})

test('reads the change request number out of a forge URL', () => {
  assert.equal(changeRequestNumberFromUrl('https://github.com/o/r/pull/132'), 132)
  assert.equal(changeRequestNumberFromUrl('https://gitlab.com/o/r/-/merge_requests/7'), 7)
  assert.equal(changeRequestNumberFromUrl('https://github.com/o/r/pull/132/files'), 132)
  assert.equal(changeRequestNumberFromUrl('https://github.com/o/r'), undefined)
})

test('picks the URL out of whatever else the CLI printed', () => {
  assert.equal(firstUrl('Warning: 3 uncommitted changes\nhttps://github.com/o/r/pull/9\n'), 'https://github.com/o/r/pull/9')
  assert.equal(firstUrl('see https://github.com/o/r/pull/9.'), 'https://github.com/o/r/pull/9')
  assert.equal(firstUrl('no url here'), undefined)
})
