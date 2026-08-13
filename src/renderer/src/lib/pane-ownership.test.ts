import assert from 'node:assert/strict'
import test from 'node:test'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error TypeScript's bundler resolution omits it in application code.
import { canMoveTab, group, groupThreadId, split, tab } from './workspaces.ts'

const checkout = (path: string, branch: string): { contextPath: string; contextLabel: string } => ({
  contextPath: path,
  contextLabel: branch
})

test('a pane belongs to its thread tab', () => {
  const threadTab = tab('thread', 'sess-a')
  const pane = group([threadTab, tab('terminal', undefined, checkout('/wt/a', 'boss/a'))])
  assert.equal(groupThreadId(pane), 'sess-a')
})

test('a pane with no thread tab belongs to nobody', () => {
  const pane = group([tab('files', undefined, checkout('/project', 'Main'))])
  assert.equal(groupThreadId(pane), undefined)
})

test('a resource cannot move into another thread pane', () => {
  const term = tab('terminal', undefined, checkout('/wt/a', 'boss/a'))
  const a = group([tab('thread', 'sess-a'), term])
  const b = group([tab('thread', 'sess-b')])
  const root = split('horizontal', a, b)
  assert.equal(canMoveTab(root, term.id, b.id), false)
})

test('a resource can move within its own pane', () => {
  const term = tab('terminal', undefined, checkout('/wt/a', 'boss/a'))
  const a = group([tab('thread', 'sess-a'), term])
  assert.equal(canMoveTab(a, term.id, a.id), true)
})

test('a resource can move into a pane holding no thread', () => {
  const term = tab('terminal', undefined, checkout('/wt/a', 'boss/a'))
  const a = group([tab('thread', 'sess-a'), term])
  const b = group([tab('browser')])
  const root = split('horizontal', a, b)
  assert.equal(canMoveTab(root, term.id, b.id), true)
})

test('threads and browsers move anywhere', () => {
  const threadTab = tab('thread', 'sess-a')
  const browserTab = tab('browser')
  const a = group([threadTab, browserTab])
  const b = group([tab('thread', 'sess-b')])
  const root = split('horizontal', a, b)
  assert.equal(canMoveTab(root, threadTab.id, b.id), true)
  assert.equal(canMoveTab(root, browserTab.id, b.id), true)
})

test('panes sharing a thread accept each other resources', () => {
  const term = tab('terminal', undefined, checkout('/wt/a', 'boss/a'))
  const a = group([tab('thread', 'sess-a'), term])
  const b = group([tab('thread', 'sess-a')])
  const root = split('horizontal', a, b)
  assert.equal(canMoveTab(root, term.id, b.id), true)
})
