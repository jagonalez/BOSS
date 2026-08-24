import assert from 'node:assert/strict'
import test from 'node:test'
// Importing bin/evals.ts would execute it, so the parser contract is exercised
// through a small child process using the public --list path instead.
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')

test('the eval CLI lists both suites without calling a model', () => {
  const lab = execFileSync(process.execPath, ['--experimental-strip-types', 'bin/evals.ts', 'lab', '--list'], { cwd: root, encoding: 'utf8' })
  assert.match(lab, /lab\.inspect-configuration/)
  assert.match(lab, /lab\.repair-implementation/)

  const assistant = execFileSync(process.execPath, ['--experimental-strip-types', 'bin/evals.ts', 'lab-assistant', '--list'], { cwd: root, encoding: 'utf8' })
  assert.match(assistant, /lab-assistant\.ambiguous-merge-order/)
  assert.match(assistant, /lab-assistant\.stable-release-approval/)
})
