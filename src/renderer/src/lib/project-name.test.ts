import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Application code uses bundler resolution.
import { projectName } from './project-name.ts'

test('projectName reads Unix and Windows paths and ignores trailing separators', () => {
  assert.equal(projectName('/Users/jeremy/dev/BOSS/'), 'BOSS')
  assert.equal(projectName('C:\\dev\\BOSS\\'), 'BOSS')
})

test('projectName gives an empty or root path a useful fallback', () => {
  assert.equal(projectName(''), 'Chat')
  assert.equal(projectName('/'), 'Chat')
})
