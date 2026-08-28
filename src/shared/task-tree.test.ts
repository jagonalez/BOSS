import assert from 'node:assert/strict'
import test from 'node:test'
// Node's type-stripping test runner requires explicit extensions.
// @ts-expect-error Application code uses bundler resolution.
import { buildTaskTree, descendantTaskNodes, flattenTaskTree } from './task-tree.ts'
import type { SupervisedThread, ThreadLineage } from './supervision.ts'

function thread(threadId: string, updatedAt: number, lineage?: ThreadLineage): SupervisedThread {
  return {
    threadId,
    backendId: 'opencode',
    title: threadId,
    projectPath: '/repo',
    executionPath: '/repo',
    updatedAt,
    running: false,
    usage: { runs: 0, durationMs: 0, tokenRuns: 0, toolCalls: 0 },
    lineage
  }
}

function delegate(sourceThreadId: string): ThreadLineage {
  return { kind: 'delegate', sourceThreadId }
}

test('nests a delegated worker under the thread that created it', () => {
  const roots = buildTaskTree([thread('parent', 3), thread('worker', 2, delegate('parent'))])
  assert.equal(roots.length, 1)
  assert.equal(roots[0].thread.threadId, 'parent')
  assert.deepEqual(roots[0].children.map((child) => child.thread.threadId), ['worker'])
  assert.equal(roots[0].children[0].depth, 1)
})

test('nests a worker spawned by another worker', () => {
  const roots = buildTaskTree([
    thread('root', 5),
    thread('mid', 4, delegate('root')),
    thread('leaf', 3, delegate('mid'))
  ])
  assert.deepEqual(
    flattenTaskTree(roots).map((node) => [node.thread.threadId, node.depth]),
    [['root', 0], ['mid', 1], ['leaf', 2]]
  )
})

test('uses a native parent id when BOSS lineage is absent', () => {
  const parent = thread('parent', 3)
  const worker = { ...thread('native-worker', 2), parentID: 'parent' }
  const roots = buildTaskTree([parent, worker])
  assert.deepEqual(roots[0].children.map((child) => child.thread.threadId), ['native-worker'])
})

test('returns descendants relative to one thread even when the owner is absent', () => {
  const direct = { ...thread('direct', 3), parentID: 'owner' }
  const nested = thread('nested', 4, delegate('direct'))
  const unrelated = thread('unrelated', 5)
  assert.deepEqual(
    descendantTaskNodes([nested, unrelated, direct], 'owner').map((node) => [node.thread.threadId, node.depth]),
    [['direct', 0], ['nested', 1]]
  )
})

test('prefers explicit BOSS lineage over a native parent id', () => {
  const worker = { ...thread('worker', 2, delegate('boss-parent')), parentID: 'native-parent' }
  assert.deepEqual(descendantTaskNodes([worker], 'boss-parent').map((node) => node.thread.threadId), ['worker'])
  assert.deepEqual(descendantTaskNodes([worker], 'native-parent'), [])
})

// Measured against real state: most lineage records point at a thread that is
// not in the same snapshot. Such a thread must stay visible as a root.
test('keeps a thread whose source is absent from the snapshot', () => {
  const roots = buildTaskTree([thread('orphan', 1, delegate('missing'))])
  assert.deepEqual(roots.map((node) => node.thread.threadId), ['orphan'])
  assert.equal(roots[0].depth, 0)
})

test('keeps every thread when lineage forms a cycle', () => {
  const roots = buildTaskTree([thread('a', 2, delegate('b')), thread('b', 1, delegate('a'))])
  assert.equal(flattenTaskTree(roots).length, 2)
})

test('does not strand a thread that points at itself', () => {
  const roots = buildTaskTree([thread('self', 1, delegate('self'))])
  assert.deepEqual(roots.map((node) => node.thread.threadId), ['self'])
})

test('orders children oldest first and keeps root order', () => {
  const roots = buildTaskTree([
    thread('newer-root', 10),
    thread('older-root', 1),
    thread('second', 9, delegate('newer-root')),
    thread('first', 4, delegate('newer-root'))
  ])
  assert.deepEqual(roots.map((node) => node.thread.threadId), ['newer-root', 'older-root'])
  assert.deepEqual(roots[0].children.map((child) => child.thread.threadId), ['first', 'second'])
})

test('returns every thread exactly once', () => {
  const threads = [
    thread('a', 3),
    thread('b', 2, delegate('a')),
    thread('c', 1, delegate('b')),
    thread('d', 4)
  ]
  const flat = flattenTaskTree(buildTaskTree(threads))
  assert.equal(flat.length, threads.length)
  assert.equal(new Set(flat.map((node) => node.thread.threadId)).size, threads.length)
})
