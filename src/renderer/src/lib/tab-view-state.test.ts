import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Application code uses bundler resolution.
import { filesViewState, forgetTabView, rememberFilesView, rememberReviewView, reviewViewState } from './tab-view-state.ts'

test('what a tab had on screen survives being moved', () => {
  // The move remounts the component, so this has to outlive it.
  rememberFilesView('tab-1', {
    expanded: ['src', 'src/main'],
    openPaths: ['src/index.ts'],
    activePath: 'src/index.ts',
    treeWidth: 320
  })
  const found = filesViewState('tab-1')
  assert.deepEqual(found?.expanded, ['src', 'src/main'])
  assert.equal(found?.activePath, 'src/index.ts')
  assert.equal(found?.treeWidth, 320)
})

test('reading does not consume the entry', () => {
  // A tab can move more than once, and each move has to find what the last one
  // left. Clearing on read would reset the tab on the move after next.
  rememberFilesView('tab-2', { expanded: [], openPaths: ['a.ts'], activePath: 'a.ts', treeWidth: 280 })
  assert.equal(filesViewState('tab-2')?.activePath, 'a.ts')
  assert.equal(filesViewState('tab-2')?.activePath, 'a.ts')
})

test('a later move overwrites what the last one left', () => {
  rememberFilesView('tab-3', { expanded: [], openPaths: ['a.ts'], activePath: 'a.ts', treeWidth: 280 })
  rememberFilesView('tab-3', { expanded: ['src'], openPaths: ['b.ts'], activePath: 'b.ts', treeWidth: 300 })
  assert.equal(filesViewState('tab-3')?.activePath, 'b.ts')
  assert.deepEqual(filesViewState('tab-3')?.expanded, ['src'])
})

test('a tab that was never moved has nothing remembered', () => {
  assert.equal(filesViewState('never-seen'), undefined)
  assert.equal(reviewViewState('never-seen'), undefined)
})

test('closing a tab drops what it held', () => {
  // Without this the map grows for the life of the app, holding paths for tabs
  // that no longer exist.
  rememberFilesView('tab-4', { expanded: [], openPaths: [], activePath: null, treeWidth: 280 })
  rememberReviewView('tab-4', { scope: 'branch', baseBranch: 'origin/main', selectedCommit: null })
  forgetTabView('tab-4')
  assert.equal(filesViewState('tab-4'), undefined)
  assert.equal(reviewViewState('tab-4'), undefined)
})

test('a review keeps the choices made in it', () => {
  rememberReviewView('tab-5', { scope: 'change-request', baseBranch: 'origin/develop', selectedCommit: 'abc123' })
  const found = reviewViewState('tab-5')
  assert.equal(found?.scope, 'change-request')
  assert.equal(found?.baseBranch, 'origin/develop')
  assert.equal(found?.selectedCommit, 'abc123')
})

test('a tab with no id is ignored rather than sharing one entry', () => {
  // Every tab has an id in practice, but they are all optional at the prop
  // level. Keying several on undefined would have them read each other's.
  rememberFilesView(undefined, { expanded: ['x'], openPaths: [], activePath: null, treeWidth: 280 })
  assert.equal(filesViewState(undefined), undefined)
})
