import assert from 'node:assert/strict'
import test from 'node:test'
import { groupByProject } from './parts.ts'

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
