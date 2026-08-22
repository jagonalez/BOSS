import assert from 'node:assert/strict'
import test from 'node:test'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error Application code uses bundler resolution.
import { GitLabReviewProvider, createMergeRequestArgs, gitlabToken, parseGitLabRemote } from './gitlab-review-provider.ts'

test('recognizes common GitLab remote formats', () => {
  assert.deepEqual(parseGitLabRemote('git@gitlab.com:group/project.git'), { project: 'group/project', origin: 'https://gitlab.com' })
  assert.deepEqual(parseGitLabRemote('https://gitlab.com/group/project.git'), { project: 'group/project', origin: 'https://gitlab.com' })
  assert.deepEqual(parseGitLabRemote('ssh://git@gitlab.com/group/project'), { project: 'group/project', origin: 'https://gitlab.com' })
})

test('keeps subgroups in the project path', () => {
  // GitLab nests groups, and the API wants the whole path, not just the last two segments.
  assert.equal(parseGitLabRemote('git@gitlab.com:group/sub/project.git')?.project, 'group/sub/project')
})

test('does not treat other forges as GitLab', () => {
  assert.equal(parseGitLabRemote('git@github.com:openai/codex.git'), undefined)
  assert.equal(parseGitLabRemote('https://github.com/openai/codex.git'), undefined)
  // A self-hosted instance is not guessable from the URL, so it is not claimed by default.
  assert.equal(parseGitLabRemote('git@git.example.com:group/project.git'), undefined)
})

test('claims a self-hosted host only when one is configured', () => {
  const original = process.env.BOSS_GITLAB_HOST
  process.env.BOSS_GITLAB_HOST = 'git.example.com'
  try {
    assert.deepEqual(parseGitLabRemote('git@git.example.com:group/project.git'), {
      project: 'group/project',
      origin: 'https://git.example.com'
    })
  } finally {
    if (original === undefined) delete process.env.BOSS_GITLAB_HOST
    else process.env.BOSS_GITLAB_HOST = original
  }
})

test('rejects a remote with no project path', () => {
  assert.equal(parseGitLabRemote('https://gitlab.com/group'), undefined)
})

test('reads the description from standard input, not an editor', () => {
  const { args, stdin } = createMergeRequestArgs({ title: 'Fix it', body: 'Because.' }, 'fix/thing')
  // `--description -` would open an editor and hang; the file form is the one that reads stdin.
  assert.ok(args.includes('--description-file'))
  assert.equal(args[args.indexOf('--description-file') + 1], '-')
  assert.ok(!args.includes('--description'))
  assert.equal(stdin, 'Because.')
})

test('never leaves glab waiting on a prompt', () => {
  // glab asks about the remote branch unless told not to.
  assert.ok(createMergeRequestArgs({ title: 't', body: 'b' }, 'fix/thing').args.includes('--yes'))
  assert.ok(createMergeRequestArgs({}, 'fix/thing').args.includes('--yes'))
})

test('asks glab to fill a request that carries neither title nor description', () => {
  const { args, stdin } = createMergeRequestArgs({}, 'fix/thing')
  assert.ok(args.includes('--fill'))
  assert.equal(stdin, undefined)
})

test('passes target branch and draft through when asked', () => {
  const { args } = createMergeRequestArgs({ title: 't', body: 'b', baseBranch: 'develop', draft: true }, 'fix/thing')
  assert.equal(args[args.indexOf('--target-branch') + 1], 'develop')
  assert.ok(args.includes('--draft'))
  assert.equal(args[args.indexOf('--source-branch') + 1], 'fix/thing')
})

test('reads a token from the variables glab itself reads', () => {
  assert.equal(gitlabToken({ GITLAB_TOKEN: 'a' }), 'a')
  assert.equal(gitlabToken({ GITLAB_ACCESS_TOKEN: 'b' }), 'b')
  // Order matters: the more specific name wins.
  assert.equal(gitlabToken({ GITLAB_TOKEN: 'a', CI_JOB_TOKEN: 'c' }), 'a')
  assert.equal(gitlabToken({}), undefined)
  assert.equal(gitlabToken({ GITLAB_TOKEN: '   ' }), undefined)
})

test('declares GitLab-specific capabilities', () => {
  const provider = new GitLabReviewProvider()
  assert.equal(provider.summary.id, 'gitlab')
  assert.equal(provider.summary.changeRequestLabel, 'Merge request')
  assert.equal(provider.summary.capabilities.createChangeRequest, true)
  // Review is not implemented for GitLab yet, and the flags have to say so.
  assert.equal(provider.summary.capabilities.publishInlineComment, false)
  assert.equal(provider.summary.capabilities.canonicalDiff, false)
})

test('matches a repository through the same parser', () => {
  const provider = new GitLabReviewProvider()
  assert.deepEqual(provider.match('git@gitlab.com:group/project.git'), { repository: 'group/project' })
  assert.equal(provider.match('git@github.com:o/r.git'), undefined)
})
