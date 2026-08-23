import assert from 'node:assert/strict'
import test from 'node:test'
import { groupByProject, sortThreads, visibleThreads } from './parts.ts'

const row = (threadId, projectPath, extra = {}) => ({ threadId, projectPath, ...extra })

test('threads are grouped by the project they run in', () => {
  const groups = groupByProject([
    row('a', '/Users/j/dev/BOSS'),
    row('b', '/Users/j/dev/BOSS'),
    row('c', '/Users/j/dev/other')
  ])
  assert.equal(groups.length, 2)
  const boss = groups.find((g) => g.name === 'BOSS')
  assert.equal(boss.threads.length, 2)
})

test('a project needing a person sorts above a busier one that does not', () => {
  // The reason to open the phone at all is that something is waiting, so that
  // has to outrank recency.
  const groups = groupByProject([
    row('recent', '/dev/quiet', { updatedAt: 9_000 }),
    row('asking', '/dev/waiting', { updatedAt: 1, attention: { kind: 'permission' } })
  ])
  assert.equal(groups[0].name, 'waiting')
  assert.equal(groups[0].waiting, 1)
})

test('threads with no project collect together rather than disappearing', () => {
  const groups = groupByProject([row('a'), row('b', '/dev/x')])
  const orphans = groups.find((g) => g.name === 'No project')
  assert.equal(orphans.threads.length, 1)
})

test('running and waiting counts are per project', () => {
  const groups = groupByProject([
    row('a', '/dev/x', { running: true }),
    row('b', '/dev/x', { attention: { kind: 'question' } }),
    row('c', '/dev/y', { running: true })
  ])
  const x = groups.find((g) => g.name === 'x')
  assert.equal(x.running, 1)
  assert.equal(x.waiting, 1)
})

test('archived and delegated threads are hidden, as they are on the desktop', () => {
  // The reported bug: 58 threads on the phone against 26 on the desktop.
  // Archiving lived in one browser's localStorage, so no other client could
  // know, and delegated workers were listed as peers of their parent.
  const rows = [
    { threadId: 'plain' },
    { threadId: 'archived', archived: true },
    { threadId: 'worker', parentID: 'plain' }
  ]
  assert.deepEqual(visibleThreads(rows).map((t) => t.threadId), ['plain'])
})

test('threads sort by time, except those blocked on a person', () => {
  const rows = [
    { threadId: 'old', updatedAt: 1 },
    { threadId: 'new', updatedAt: 9 },
    { threadId: 'asking', updatedAt: 2, attention: { kind: 'permission' } }
  ]
  assert.deepEqual(sortThreads(rows).map((t) => t.threadId), ['asking', 'new', 'old'])
})

test('a finished or failed thread does not jump the queue', () => {
  // These used to rank above merely-recent threads and colour the row red or
  // green, which told you the past rather than what to do.
  const rows = [
    { threadId: 'failed', updatedAt: 1, attention: { kind: 'error' } },
    { threadId: 'done', updatedAt: 2, attention: { kind: 'completed' } },
    { threadId: 'recent', updatedAt: 8 }
  ]
  assert.deepEqual(sortThreads(rows).map((t) => t.threadId), ['recent', 'done', 'failed'])
})
