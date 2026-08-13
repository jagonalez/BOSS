import assert from 'node:assert/strict'
import test from 'node:test'
import { bindTemplate, group, tab, templateFromWorkspace, walkTabs, workspaceView } from './workspaces.ts'

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
