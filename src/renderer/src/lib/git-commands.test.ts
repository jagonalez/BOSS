import assert from 'node:assert/strict'
import test from 'node:test'
import type { StatusFile } from './diff'
import { gitStageArgs, gitUnstageArgs, planBranchSwitch, preferredCompareBranch, stashRefForOid } from './git-commands.ts'

function file(path: string, extra: Partial<StatusFile> = {}): StatusFile {
  return { path, staged: false, unstaged: false, untracked: false, ...extra }
}

test('staging builds one targeted add per entry', () => {
  assert.deepEqual(gitStageArgs([
    file('src/edited.ts'),
    file('scratch.ts', { untracked: true }),
    file('gone.ts')
  ]), [
    ['add', '--', 'src/edited.ts'],
    ['add', '--', 'scratch.ts'],
    ['add', '--', 'gone.ts']
  ])
})

test('staging a rename names both sides so the index records the move', () => {
  const renamed = file('src/new-name.ts', { oldPath: 'src/old-name.ts' })
  assert.deepEqual(gitStageArgs([renamed]), [['add', '--', 'src/old-name.ts', 'src/new-name.ts']])
})

test('unstaging builds one restore per side of an entry', () => {
  assert.deepEqual(gitUnstageArgs([
    file('src/staged.ts', { staged: true }),
    file('src/new-name.ts', { oldPath: 'src/old-name.ts', staged: true })
  ]), [
    ['restore', '--staged', '--', 'src/staged.ts'],
    ['restore', '--staged', '--', 'src/old-name.ts', 'src/new-name.ts']
  ])
})

test('unstaging before the first commit removes paths from the index without HEAD', () => {
  assert.deepEqual(gitUnstageArgs([file('first file.ts', { staged: true })], false), [
    ['rm', '--cached', '--ignore-unmatch', '--', 'first file.ts']
  ])
})

test('an empty selection constructs no commands', () => {
  assert.deepEqual(gitStageArgs([]), [])
  assert.deepEqual(gitUnstageArgs([]), [])
})

test('a clean tree switches directly', () => {
  assert.deepEqual(planBranchSwitch([], [], ['anything']), { action: 'direct' })
})

test('a dirty tree that does not collide with the target may stash and switch', () => {
  const plan = planBranchSwitch(['a.ts', 'b.ts'], ['c.ts'], ['other.ts'])
  assert.equal(plan.action, 'stash')
})

test('local edits to paths the target also changes block the switch', () => {
  const plan = planBranchSwitch(['shared.ts'], [], ['shared.ts', 'moved-on-target.ts'])
  assert.equal(plan.action, 'block')
  assert.deepEqual(plan.conflicts, ['shared.ts'])
})

test('an untracked file the target would overwrite blocks the switch too', () => {
  // Checkout refuses outright when the incoming branch carries a path that
  // exists untracked locally, so it is not trivially safe either.
  const plan = planBranchSwitch([], ['appears-on-both.ts'], ['appears-on-both.ts'])
  assert.equal(plan.action, 'block')
})

test('file-directory collisions block a stash switch', () => {
  const plan = planBranchSwitch([], ['dir/local.ts'], ['dir'])
  assert.equal(plan.action, 'block')
  assert.deepEqual(plan.conflicts, ['dir/local.ts'])
})

test('captured stash commits resolve to their current reflog entry', () => {
  assert.equal(stashRefForOid(['newer', 'ours', 'older'], 'ours'), 'stash@{1}')
  assert.equal(stashRefForOid(['newer', 'older'], 'ours'), null)
})

test('compare prefers the remote default branch over the current branch', () => {
  assert.equal(
    preferredCompareBranch(['feature', 'main', 'origin/main', 'origin/HEAD'], 'feature', 'origin/main'),
    'origin/main'
  )
})

test('compare falls back to a different local branch when no remote base exists', () => {
  assert.equal(preferredCompareBranch(['feature', 'main'], 'feature'), 'main')
  assert.equal(preferredCompareBranch(['only'], 'only'), '')
})
