import assert from 'node:assert/strict'
import test from 'node:test'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error TypeScript's bundler resolution omits it in application code.
import { cloneLayout, group, pane, split, tab, walkGroups, walkPanes, wrapLegacyPanes } from './workspaces.ts'

/**
 * isNode decides whether a saved layout is kept or discarded, so a tree it
 * misjudges costs the user their workspace rather than merely looking wrong.
 * It is not exported, but loadTemplates filters on it, so exercise it there.
 */

test('a pane round-trips through clone', () => {
  const original = pane('sess-a', group([tab('thread', 'sess-a'), tab('terminal')]))
  const copy = cloneLayout(original)
  assert.equal(copy.type, 'pane')
  assert.equal(copy.sessionId, 'sess-a')
  assert.equal(walkGroups(copy).length, 1)
  assert.equal(walkGroups(copy)[0].tabs.length, 2)
})

test('clone strips the thread binding when asked', () => {
  const copy = cloneLayout(pane('sess-a', group([tab('thread', 'sess-a')])), true)
  assert.equal(copy.sessionId, undefined)
})

test('panes tile inside a view and resources tile inside a pane', () => {
  const left = pane('sess-a', split('vertical', group([tab('thread', 'sess-a')]), group([tab('terminal')])))
  const right = pane('sess-b', group([tab('thread', 'sess-b')]))
  const view = split('horizontal', left, right)

  const panes = walkPanes(view)
  assert.equal(panes.length, 2)
  assert.deepEqual(panes.map((item) => item.sessionId), ['sess-a', 'sess-b'])
  // The left pane splits its own resources.
  assert.equal(walkGroups(left).length, 2)
})

test('walkGroups reaches through panes', () => {
  const view = split('horizontal', pane('sess-a', group([tab('thread', 'sess-a')])), group([tab('browser')]))
  assert.equal(walkGroups(view).length, 2)
})

test('a blank pane carries no thread', () => {
  const blank = pane(undefined, group([tab('terminal')]))
  assert.equal(blank.sessionId, undefined)
  assert.equal(walkPanes(blank).length, 1)
})

test('a workspace saved before panes existed still loads with them', () => {
  // What v3 layouts look like on disk today: groups, no panes.
  const legacy = split('horizontal', group([tab('thread', 'sess-a'), tab('terminal')]), group([tab('browser')]))
  const migrated = wrapLegacyPanes(legacy)

  const panes = walkPanes(migrated)
  assert.equal(panes.length, 2)
  // The group holding a thread becomes that thread's pane.
  assert.equal(panes[0].sessionId, 'sess-a')
  // A group of loose resources becomes a blank pane, which is what it was.
  assert.equal(panes[1].sessionId, undefined)
  // No tabs lost.
  assert.equal(walkGroups(migrated).flatMap((item) => item.tabs).length, 3)
})

test('migrating an already-migrated layout changes nothing', () => {
  const once = wrapLegacyPanes(split('horizontal', group([tab('thread', 'sess-a')]), group([tab('files')])))
  const twice = wrapLegacyPanes(once)
  assert.equal(walkPanes(twice).length, walkPanes(once).length)
  assert.deepEqual(walkPanes(twice).map((item) => item.sessionId), ['sess-a', undefined])
})

test('nested panes are all found', () => {
  const view = split(
    'horizontal',
    pane('sess-a', group([tab('thread', 'sess-a')])),
    split('vertical', pane('sess-b', group([tab('thread', 'sess-b')])), pane('sess-c', group([tab('thread', 'sess-c')])))
  )
  assert.deepEqual(walkPanes(view).map((item) => item.sessionId), ['sess-a', 'sess-b', 'sess-c'])
})
