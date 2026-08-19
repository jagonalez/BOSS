import assert from 'node:assert/strict'
import test from 'node:test'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error Application code uses bundler resolution.
import { orderedProjects } from './projects.ts'

test('a dragged order replaces the stored one', () => {
  assert.deepEqual(orderedProjects(['/c', '/a', '/b'], ['/a', '/b', '/c']), ['/c', '/a', '/b'])
})

test('a project the renderer never drew keeps its place behind the drawn ones', () => {
  // The sidebar hides a stored project whose folder has gone, so its order
  // must survive a drag rather than be read as a removal.
  assert.deepEqual(orderedProjects(['/b', '/a'], ['/a', '/b', '/gone']), ['/b', '/a', '/gone'])
})

test('a project shown only because a thread points at it is stored on drop', () => {
  // Backends report sessions in folders BOSS was never asked to open. Dropping
  // those would make dragging such a row do nothing.
  assert.deepEqual(orderedProjects(['/fromsession', '/a'], ['/a']), ['/fromsession', '/a'])
})

test('empty and repeated paths are discarded', () => {
  assert.deepEqual(orderedProjects(['/a', '', '/a', '/b'], ['/a', '/b']), ['/a', '/b'])
})
