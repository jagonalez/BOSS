import assert from 'node:assert/strict'
import test from 'node:test'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error TypeScript's bundler resolution omits it in application code.
import { canMoveTab, group, groupThreadId, pane, split, tab } from './workspaces.ts'

const checkout = (path: string, branch: string): { contextPath: string; contextLabel: string } => ({
  contextPath: path,
  contextLabel: branch
})

test('a group reports the thread of its own thread tab', () => {
  const threadTab = tab('thread', 'sess-a')
  const target = group([threadTab, tab('terminal', undefined, checkout('/wt/a', 'boss/a'))])
  assert.equal(groupThreadId(target), 'sess-a')
})

test('a group with no thread tab reports none', () => {
  assert.equal(groupThreadId(group([tab('files', undefined, checkout('/project', 'Main'))])), undefined)
})

test('a resource never leaves its pane', () => {
  const term = tab('terminal', undefined, checkout('/wt/a', 'boss/a'))
  const a = group([tab('thread', 'sess-a'), term])
  const b = group([tab('thread', 'sess-b')])
  const root = split('horizontal', pane('sess-a', a), pane('sess-b', b))
  assert.equal(canMoveTab(root, term.id, b.id), false)
})

test('not even into a pane holding no thread', () => {
  const term = tab('terminal', undefined, checkout('/wt/a', 'boss/a'))
  const a = group([tab('thread', 'sess-a'), term])
  const b = group([tab('browser')])
  const root = split('horizontal', pane('sess-a', a), pane(undefined, b))
  assert.equal(canMoveTab(root, term.id, b.id), false)
})

test('a resource still reorders inside its own pane', () => {
  const term = tab('terminal', undefined, checkout('/wt/a', 'boss/a'))
  const a = group([tab('thread', 'sess-a'), term])
  assert.equal(canMoveTab(a, term.id, a.id), true)
})

test('threads move between panes', () => {
  const threadTab = tab('thread', 'sess-a')
  const a = group([threadTab])
  const b = group([tab('thread', 'sess-b')])
  const root = split('horizontal', pane('sess-a', a), pane('sess-b', b))
  assert.equal(canMoveTab(root, threadTab.id, b.id), true)
})

test('a browser is a resource too, so it stays put', () => {
  const browserTab = tab('browser')
  const a = group([tab('thread', 'sess-a'), browserTab])
  const b = group([tab('thread', 'sess-b')])
  const root = split('horizontal', pane('sess-a', a), pane('sess-b', b))
  assert.equal(canMoveTab(root, browserTab.id, b.id), false)
})
