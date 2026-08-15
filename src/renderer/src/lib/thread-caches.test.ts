import assert from 'node:assert/strict'
import test from 'node:test'
import { pruneDeletedThreadCaches } from './thread-caches.ts'

test('deleting a thread preserves the cached content of every other thread', () => {
  const messages = {
    deleting: ['delete me'],
    leftPane: ['left conversation'],
    rightPane: ['right conversation']
  }
  const todos = {
    deleting: ['delete me'],
    leftPane: ['left todo'],
    rightPane: ['right todo']
  }

  const next = pruneDeletedThreadCaches(messages, todos, 'deleting')

  assert.deepEqual(next.messages, {
    leftPane: ['left conversation'],
    rightPane: ['right conversation']
  })
  assert.deepEqual(next.todos, {
    leftPane: ['left todo'],
    rightPane: ['right todo']
  })
  assert.deepEqual(messages.deleting, ['delete me'], 'the previous state remains immutable')
  assert.deepEqual(todos.deleting, ['delete me'], 'the previous state remains immutable')
})
