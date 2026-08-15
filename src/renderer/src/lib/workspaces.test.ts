import assert from 'node:assert/strict'
import test from 'node:test'
import { BUILTIN_LAYOUTS, arrangeInto, findOwnedResource, withUniqueIds, workspaceId, closeGroup, closeTab, group, moveTab, moveTabAcrossViews, placementIndex, resourcesByThread, split, tab, walkGroups, walkTabs, workspaceMenuRight, workspaceView } from './workspaces.ts'

test('workspace add menus align to their trigger and stay inside the pane', () => {
  assert.equal(workspaceMenuRight(900, 100, 1_000), 100)
  assert.equal(workspaceMenuRight(990, 100, 1_000), 10)
  assert.equal(workspaceMenuRight(200, 100, 1_000), 672)
  assert.equal(workspaceMenuRight(180, 100, 260), 8)
})

test('the grids are empty shapes', () => {
  // A layout that carried tabs would decide what you need open. These describe
  // panes and nothing else.
  for (const layout of BUILTIN_LAYOUTS) {
    assert.deepEqual(walkTabs(layout.root), [], `${layout.name} should hold no tabs`)
  }
  assert.deepEqual(BUILTIN_LAYOUTS.map((item) => walkGroups(item.root).length), [1, 2, 2, 3, 4])
})

test('a tab drops into an empty pane', () => {
  const [full, ...rest] = [group([tab('thread', 'thread-1')]), group(), group(), group()]
  const root = split('horizontal', split('vertical', full, rest[0]), split('vertical', rest[1], rest[2]))

  const moved = moveTab(root, full.tabs[0].id, rest[0].id, 'center')

  const landed = walkGroups(moved.root).find((item) => item.tabs.length > 0)
  assert.equal(landed?.id, rest[0].id, 'the tab should be in the pane it was dropped on')
  assert.equal(moved.focusedGroupId, rest[0].id)
})

test('moving a tab keeps the rest of the grid', () => {
  // The pane a tab leaves goes away, because nothing made it. The other empty
  // panes are the grid the user asked for, so dragging must not delete them.
  const [full, ...rest] = [group([tab('thread', 'thread-1')]), group(), group(), group()]
  const root = split('horizontal', split('vertical', full, rest[0]), split('vertical', rest[1], rest[2]))

  const moved = moveTab(root, full.tabs[0].id, rest[2].id, 'center')

  const ids = walkGroups(moved.root).map((item) => item.id)
  assert.ok(!ids.includes(full.id), 'the emptied pane should collapse')
  for (const kept of [rest[0], rest[1], rest[2]]) {
    assert.ok(ids.includes(kept.id), 'an untouched empty pane should survive the drag')
  }
})

test('closing the last tab in a pane leaves the other panes alone', () => {
  const [closing, empty] = [group([tab('terminal', 'thread-1')]), group()]
  const root = split('horizontal', closing, empty)

  const after = closeTab(root, closing.id, closing.tabs[0].id)

  assert.deepEqual(walkGroups(after).map((item) => item.id), [empty.id])
})

const gridNamed = (name: string) => BUILTIN_LAYOUTS.find((item) => item.name === name)!

test('a grid deals the panes you already have into its shape', () => {
  const checkout = { contextPath: '/tmp/wt', worktreeId: 'wt-1', contextLabel: 'boss/test' }
  const view = workspaceView('Main', split('horizontal',
    group([tab('thread', 'thread-1')]),
    group([tab('terminal', 'thread-1', checkout)])
  ))
  const before = walkTabs(view.root)

  const arranged = arrangeInto(gridNamed('2 × 2'), view)
  const after = walkTabs(arranged.root)

  // The same tabs, so a running shell and a loaded page carry over. Ids are
  // what the terminal and browser caches key on.
  assert.deepEqual(after.map((item) => item.id).sort(), before.map((item) => item.id).sort())
  assert.equal(walkGroups(arranged.root).length, 4)
  assert.equal(after.find((item) => item.kind === 'terminal')?.contextPath, checkout.contextPath)
})

test('a grid smaller than what is open keeps everything', () => {
  const view = workspaceView('Main', split('horizontal',
    group([tab('thread', 'thread-1')]),
    split('horizontal', group([tab('terminal', 'thread-1')]), group([tab('browser')]))
  ))
  const before = walkTabs(view.root)

  // Three panes of tabs, one pane to put them in.
  const arranged = arrangeInto(gridNamed('1 × 1'), view)

  // Applying a shape must not quietly kill a shell it had no pane for.
  assert.deepEqual(walkTabs(arranged.root).map((item) => item.id).sort(), before.map((item) => item.id).sort())
  assert.equal(walkGroups(arranged.root).length, 1)
})

test('a grid bigger than what is open leaves panes empty', () => {
  const view = workspaceView('Main', group([tab('thread', 'thread-1')]))

  const arranged = arrangeInto(gridNamed('2 × 2'), view)
  const panes = walkGroups(arranged.root)

  // A grid describes where things go, not what to open. Filling the spare
  // panes here would start work the user did not ask for.
  assert.equal(panes.length, 4)
  assert.deepEqual(panes.filter((item) => item.tabs.length > 0).length, 1)
  assert.deepEqual(walkTabs(arranged.root).map((item) => item.kind), ['thread'])
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

test('a name given to a resource survives a grid', () => {
  const view = workspaceView('Main', group([
    tab('thread', 'thread-1'),
    { ...tab('terminal', 'thread-1', { contextPath: '/tmp/wt' }), title: 'Test runner' }
  ]))

  // Applying a grid moves panes about. The terminal is the same terminal
  // afterwards, so the name the user gave it has to come along.
  const after = walkTabs(arrangeInto(gridNamed('2 × 1'), view).root)
  assert.equal(after.find((item) => item.kind === 'terminal')?.title, 'Test runner')
})

test('threads are not listed as resources of themselves', () => {
  const view = workspaceView('Main', group([tab('thread', 'thread-1'), tab('terminal', 'thread-1')]))
  const owned = resourcesByThread([view])

  assert.deepEqual((owned.get('thread-1') ?? []).map((item) => item.kind), ['terminal'])
})

test('a new id never repeats', () => {
  // The old generator combined a second-resolution timestamp with a counter
  // that reset on reload, so a tab made after a restart could take the id of
  // one already on screen.
  const ids = new Set(Array.from({ length: 500 }, () => workspaceId('tab')))
  assert.equal(ids.size, 500)
})

test('a saved workspace with a repeated id is repaired', () => {
  // Two tabs with one id overwrite each other: the slot each paints into and
  // the terminal and browser caches are all keyed by it.
  const first = tab('thread', 'thread-1')
  const clash = { ...tab('files'), id: first.id }
  const view = workspaceView('Main', split('horizontal', group([first]), group([clash])))

  const fixed = withUniqueIds({ views: [view], activeViewId: view.id, updatedAt: 0 })
  const ids = walkTabs(fixed.views[0].root).map((item) => item.id)

  assert.equal(new Set(ids).size, 2, 'both tabs should have their own id')
  assert.equal(ids[0], first.id, 'the first use keeps its id, so a live terminal is not orphaned')
  assert.notEqual(ids[1], first.id)
})

test('repair leaves a clean workspace untouched', () => {
  const view = workspaceView('Main', split('horizontal',
    group([tab('thread', 'thread-1')]),
    group([tab('files'), tab('terminal')])
  ))
  const before = { views: [view], activeViewId: view.id, updatedAt: 0 }
  const after = withUniqueIds(before)

  assert.deepEqual(walkTabs(after.views[0].root).map((item) => item.id), walkTabs(view.root).map((item) => item.id))
  assert.deepEqual(walkGroups(after.views[0].root).map((item) => item.id), walkGroups(view.root).map((item) => item.id))
  assert.equal(after.activeViewId, before.activeViewId)
})

test('the active tab points at a tab that exists after repair', () => {
  // activeTabId names an id that may have just been replaced. When the clash is
  // within one pane there is no way to tell which tab was meant — both had the
  // same id — so it resolves to the first, which at least exists.
  const first = tab('thread', 'thread-1')
  const clash = { ...tab('files'), id: first.id }
  const pane = group([first, clash])
  pane.activeTabId = clash.id
  const view = workspaceView('Main', pane)

  const fixed = withUniqueIds({ views: [view], activeViewId: view.id, updatedAt: 0 })
  const group0 = walkGroups(fixed.views[0].root)[0]

  assert.ok(
    group0.tabs.some((item) => item.id === group0.activeTabId),
    'the active tab must be one of the tabs in the pane'
  )
})

test('an active tab keeps its place when the clash is elsewhere', () => {
  // The ordinary case: the duplicate is in another pane, so this pane's own
  // active tab is unambiguous and must not move.
  const here = [tab('thread', 'thread-1'), tab('files')]
  const pane = group(here)
  pane.activeTabId = here[1].id
  const elsewhere = group([{ ...tab('terminal'), id: here[0].id }])
  const view = workspaceView('Main', split('horizontal', pane, elsewhere))

  const fixed = withUniqueIds({ views: [view], activeViewId: view.id, updatedAt: 0 })
  const group0 = walkGroups(fixed.views[0].root)[0]

  assert.equal(group0.activeTabId, here[1].id, 'the files tab is still the active one')
})

test('two views sharing an id are separated', () => {
  const one = workspaceView('One', group([tab('thread', 'a')]))
  const two = { ...workspaceView('Two', group([tab('thread', 'b')])), id: one.id }

  const fixed = withUniqueIds({ views: [one, two], activeViewId: one.id, updatedAt: 0 })

  assert.notEqual(fixed.views[0].id, fixed.views[1].id)
  assert.equal(fixed.activeViewId, fixed.views[0].id)
})

test('a thread gets its own review, not the one another thread opened', () => {
  // What went wrong: reviews were deduped on the checkout alone, so asking
  // from a second thread on the same checkout handed back the first thread's
  // tab. The diff was right; the sidebar files a resource under its owner, so
  // it appeared under someone else's thread.
  const theirs = { ...tab('review', 'thread-1', { contextPath: '/src/ralf' }) }
  const view = workspaceView('Main', group([tab('thread', 'thread-1'), theirs]))

  const found = findOwnedResource(view.root, 'review', 'thread-2', '/src/ralf')
  assert.equal(found, undefined, 'another thread must not be given this one')
})

test('asking twice from one thread reuses its review', () => {
  const mine = { ...tab('review', 'thread-1', { contextPath: '/src/ralf' }) }
  const view = workspaceView('Main', group([tab('thread', 'thread-1'), mine]))

  const found = findOwnedResource(view.root, 'review', 'thread-1', '/src/ralf')
  assert.equal(found?.id, mine.id)
})

test('a thread moved to a worktree gets a review for it', () => {
  // A thread is not fixed to one checkout: an agent can put it on a fresh
  // worktree mid-conversation, and a cleaned-up worktree drops it back.
  const onMain = { ...tab('review', 'thread-1', { contextPath: '/src/ralf' }) }
  const view = workspaceView('Main', group([tab('thread', 'thread-1'), onMain]))

  const found = findOwnedResource(view.root, 'review', 'thread-1', '/worktrees/thread-1')
  assert.equal(found, undefined, 'a different checkout is a different review')
})

test('a files tab and a review on one checkout stay separate', () => {
  const review = { ...tab('review', 'thread-1', { contextPath: '/src/ralf' }) }
  const view = workspaceView('Main', group([tab('thread', 'thread-1'), review]))

  assert.equal(findOwnedResource(view.root, 'files', 'thread-1', '/src/ralf'), undefined)
  assert.equal(findOwnedResource(view.root, 'review', 'thread-1', '/src/ralf')?.id, review.id)
})
