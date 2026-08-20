import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Node's type-stripping test runner requires the explicit extension.
import { unpackedAsarPath } from './claude-executable.ts'

test('maps packaged ASAR paths to literal unpacked paths', () => {
  assert.equal(
    unpackedAsarPath('/Applications/BOSS.app/Contents/Resources/app.asar/node_modules/claude'),
    '/Applications/BOSS.app/Contents/Resources/app.asar.unpacked/node_modules/claude'
  )
  assert.equal(
    unpackedAsarPath('C:\\BOSS\\resources\\app.asar\\node_modules\\claude.exe'),
    'C:\\BOSS\\resources\\app.asar.unpacked\\node_modules\\claude.exe'
  )
})
