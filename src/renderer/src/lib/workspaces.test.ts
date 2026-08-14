import assert from 'node:assert/strict'
import test from 'node:test'
import { bindTemplate, group, placementIndex, resourcesByThread, tab, templateFromWorkspace, walkTabs, workspaceMenuRight, workspaceView } from './workspaces.ts'

test('workspace add menus align to their trigger and stay inside the pane', () => {
  assert.equal(workspaceMenuRight(900, 100, 1_000), 100)
  assert.equal(workspaceMenuRight(990, 100, 1_000), 10)
  assert.equal(workspaceMenuRight(200, 100, 1_000), 672)
  assert.equal(workspaceMenuRight(180, 100, 260), 8)
})

test('saved formats strip thread and checkout bindings', () => {
  const view = workspaceView('Main', group([
    tab('thread', 'thread-1'),
    tab('terminal', undefined, { contextPath: '/tmp/worktree', worktreeId: 'wt-1', contextLabel: 'boss/test' }),
    tab('review', undefined, { contextPath: '/tmp/worktree', worktreeId: 'wt-1', contextLabel: 'boss/test' }),
    tab('files', undefined, { contextPath: '/tmp/worktree', worktreeId: 'wt-1', contextLabel: 'boss/test' })
  ]))

  const template = templateFromWorkspace(view, 'Bound layout')
  for (const item of walkTabs(template.root)) {
    assert.equal(item.sessionId, undefined)
    assert.equal(item.contextPath, undefined)
    assert.equal(item.worktreeId, undefined)
    assert.equal(item.contextLabel, undefined)
  }
})

test('applying a format binds checkout tools and removes duplicate singleton surfaces', () => {
  const template = {
    id: 'format-1',
    name: 'Review layout',
    favorite: true,
    root: group([tab('thread'), tab('review'), tab('review'), tab('files'), tab('files'), tab('terminal')])
  }
  const checkout = { contextPath: '/tmp/worktree', worktreeId: 'wt-1', contextLabel: 'boss/test' }
  const view = bindTemplate(template, 'Main', ['thread-1'], checkout)
  const items = walkTabs(view.root)

  assert.equal(items.filter((item) => item.kind === 'review').length, 1)
  assert.equal(items.filter((item) => item.kind === 'files').length, 1)
  assert.equal(items.find((item) => item.kind === 'thread')?.sessionId, 'thread-1')
  for (const item of items.filter((candidate) => candidate.kind === 'terminal' || candidate.kind === 'review' || candidate.kind === 'files')) {
    assert.equal(item.contextPath, checkout.contextPath)
    assert.equal(item.worktreeId, checkout.worktreeId)
    assert.equal(item.contextLabel, checkout.contextLabel)
  }
})

test('the placement index locates every tab across every view', () => {
  const main = workspaceView('Main', group([tab('thread', 'thread-1'), tab('terminal', 'thread-1')]))
  const review = workspaceView('Review', group([tab('files', 'thread-1'), tab('thread', 'thread-2')]))
  const index = placementIndex([main, review])

  const terminal = walkTabs(main.root).find((item) => item.kind === 'terminal')!
  const files = walkTabs(review.root).find((item) => item.kind === 'files')!

  assert.equal(index.get(terminal.id)?.viewId, main.id)
  assert.equal(index.get(files.id)?.viewId, review.id)
  assert.equal(index.get(files.id)?.viewName, 'Review')
  assert.equal(index.size, 4)
})

test('a resource is listed under its thread even from another view', () => {
  // The whole point of the tree: thread-1's files tab sits in Review while
  // thread-1 itself sits in Main, and the sidebar still files it correctly.
  const main = workspaceView('Main', group([tab('thread', 'thread-1')]))
  const review = workspaceView('Review', group([tab('files', 'thread-1')]))
  const owned = resourcesByThread([main, review])

  const listed = owned.get('thread-1') ?? []
  assert.equal(listed.length, 1)
  assert.equal(listed[0].kind, 'files')
  assert.equal(listed[0].viewName, 'Review')
})

test('threads are not listed as resources of themselves', () => {
  const view = workspaceView('Main', group([tab('thread', 'thread-1'), tab('terminal', 'thread-1')]))
  const owned = resourcesByThread([view])

  assert.deepEqual((owned.get('thread-1') ?? []).map((item) => item.kind), ['terminal'])
})
