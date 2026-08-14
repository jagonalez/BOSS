import assert from 'node:assert/strict'
import test from 'node:test'
import { arrangeInto, closeGroup, group, moveTabAcrossViews, placementIndex, resourcesByThread, split, tab, layoutFromView, walkGroups, walkTabs, workspaceMenuRight, workspaceView } from './workspaces.ts'

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

  const template = layoutFromView(view, 'Bound layout')
  for (const item of walkTabs(template.root)) {
    assert.equal(item.sessionId, undefined)
    assert.equal(item.contextPath, undefined)
    assert.equal(item.worktreeId, undefined)
    assert.equal(item.contextLabel, undefined)
  }
})

test('applying a layout moves the tabs you already have', () => {
  const checkout = { contextPath: '/tmp/wt', worktreeId: 'wt-1', contextLabel: 'boss/test' }
  const view = workspaceView('Main', group([
    tab('thread', 'thread-1'),
    tab('terminal', 'thread-1', checkout)
  ]))
  const before = walkTabs(view.root)

  const layout = {
    id: 'layout-1',
    name: 'Side by side',
    favorite: true,
    root: split('horizontal', group([tab('thread')]), group([tab('terminal')]))
  }
  const arranged = arrangeInto(layout, view)
  const after = walkTabs(arranged.root)

  // The same tabs, so a running shell and a loaded page carry over. Ids are
  // what the terminal and browser caches key on.
  assert.deepEqual(after.map((item) => item.id).sort(), before.map((item) => item.id).sort())
  assert.equal(walkGroups(arranged.root).length, 2)
  assert.equal(after.find((item) => item.kind === 'terminal')?.contextPath, checkout.contextPath)
})

test('a layout with no room for something keeps it anyway', () => {
  const view = workspaceView('Main', group([
    tab('thread', 'thread-1'),
    tab('terminal', 'thread-1'),
    tab('terminal', 'thread-1')
  ]))
  const before = walkTabs(view.root)

  // One terminal slot, two terminals open.
  const layout = {
    id: 'layout-2',
    name: 'Focus',
    favorite: false,
    root: group([tab('thread'), tab('terminal')])
  }
  const after = walkTabs(arrangeInto(layout, view).root)

  // Applying a shape must not quietly kill a shell it had no slot for.
  assert.deepEqual(after.map((item) => item.id).sort(), before.map((item) => item.id).sort())
})

test('a layout asking for what you do not have leaves the slot empty', () => {
  const view = workspaceView('Main', group([tab('thread', 'thread-1')]))

  const layout = {
    id: 'layout-3',
    name: 'Web development',
    favorite: false,
    root: split('horizontal', group([tab('thread')]), group([tab('browser'), tab('terminal')]))
  }
  const after = walkTabs(arrangeInto(layout, view).root)

  // A shape describes where things go, not what to open. Creating a browser
  // and a terminal here would start work the user did not ask for.
  assert.deepEqual(after.map((item) => item.kind), ['thread'])
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

test('a resource moves out of one view and into another', () => {
  const main = workspaceView('Main', group([tab('thread', 'thread-1'), tab('terminal', 'thread-1')]))
  const review = workspaceView('Review', group([tab('thread', 'thread-2')]))
  const terminal = walkTabs(main.root).find((item) => item.kind === 'terminal')!
  const target = walkGroups(review.root)[0]

  const moved = moveTabAcrossViews([main, review], terminal.id, review.id, target.id, 'center')

  assert.equal(walkTabs(moved[0].root).some((item) => item.id === terminal.id), false)
  assert.equal(walkTabs(moved[1].root).some((item) => item.id === terminal.id), true)
  // The thread stays put: moving a resource does not drag its thread along.
  assert.equal(walkTabs(moved[0].root).some((item) => item.kind === 'thread'), true)
})

test('moving a resource keeps its owner and checkout', () => {
  const checkout = { contextPath: '/tmp/worktree', worktreeId: 'wt-1', contextLabel: 'boss/test' }
  const main = workspaceView('Main', group([tab('files', 'thread-1', checkout)]))
  const review = workspaceView('Review', group([tab('thread', 'thread-2')]))
  const files = walkTabs(main.root)[0]
  const target = walkGroups(review.root)[0]

  const moved = moveTabAcrossViews([main, review], files.id, review.id, target.id, 'center')
  const landed = walkTabs(moved[1].root).find((item) => item.id === files.id)!

  assert.equal(landed.sessionId, 'thread-1')
  assert.equal(landed.contextPath, checkout.contextPath)
  assert.equal(landed.worktreeId, checkout.worktreeId)
})

test('moving a resource within one view leaves the other views alone', () => {
  const main = workspaceView('Main', group([tab('thread', 'thread-1'), tab('terminal', 'thread-1')]))
  const review = workspaceView('Review', group([tab('files', 'thread-1')]))
  const terminal = walkTabs(main.root).find((item) => item.kind === 'terminal')!
  const target = walkGroups(main.root)[0]

  const moved = moveTabAcrossViews([main, review], terminal.id, main.id, target.id, 'right')

  assert.equal(walkTabs(moved[0].root).length, 2)
  assert.deepEqual(walkTabs(moved[1].root).map((item) => item.kind), ['files'])
})

test('a view list snapshot restores a closed pane whole', () => {
  // What the undo relies on: views are values, so holding the old array is
  // enough to bring back a pane and everything that was in it.
  const main = workspaceView('Main', split('horizontal',
    group([tab('thread', 'thread-1'), tab('terminal', 'thread-1')]),
    group([tab('files', 'thread-2')])
  ))
  const before = [main]
  const doomed = walkGroups(main.root)[0]

  const after = before.map((view) => ({ ...view, root: closeGroup(view.root, doomed.id) }))
  assert.equal(walkTabs(after[0].root).length, 1)

  // The snapshot is untouched by the close, so restoring it is a plain swap.
  assert.equal(walkTabs(before[0].root).length, 3)
  assert.equal(walkGroups(before[0].root).length, 2)
})

test('a name given to a resource does not follow it into a saved format', () => {
  const view = workspaceView('Main', group([
    tab('thread', 'thread-1'),
    { ...tab('terminal', 'thread-1', { contextPath: '/tmp/wt' }), title: 'Test runner' }
  ]))

  const named = walkTabs(view.root).find((item) => item.kind === 'terminal')
  assert.equal(named?.title, 'Test runner')

  // A format is a shape. "Test runner" describes one particular terminal, so
  // it would be wrong on every layout built from this one.
  for (const item of walkTabs(layoutFromView(view, 'Saved').root)) {
    assert.equal(item.title, undefined)
  }
})

test('threads are not listed as resources of themselves', () => {
  const view = workspaceView('Main', group([tab('thread', 'thread-1'), tab('terminal', 'thread-1')]))
  const owned = resourcesByThread([view])

  assert.deepEqual((owned.get('thread-1') ?? []).map((item) => item.kind), ['terminal'])
})
