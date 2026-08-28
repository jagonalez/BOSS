import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-ignore Node's strip-types test runner requires the source extension.
import { knownProjectCandidates } from './project-target.ts'

const projects = ['/work/acme/web', '/work/acme/api', '/archive/other/api']

test('an opened project can be selected by its full path', () => {
  assert.deepEqual(knownProjectCandidates('/work/acme/web', projects), ['/work/acme/web'])
  assert.deepEqual(knownProjectCandidates('/work/acme/web/', projects), ['/work/acme/web'])
})

test('a unique project folder name is enough', () => {
  assert.deepEqual(knownProjectCandidates('WEB', projects), ['/work/acme/web'])
})

test('ambiguous folder names stay ambiguous for the caller to reject', () => {
  assert.deepEqual(knownProjectCandidates('api', projects), ['/work/acme/api', '/archive/other/api'])
})

test('unknown and empty projects do not resolve', () => {
  assert.deepEqual(knownProjectCandidates('mobile', projects), [])
  assert.deepEqual(knownProjectCandidates('  ', projects), [])
})
