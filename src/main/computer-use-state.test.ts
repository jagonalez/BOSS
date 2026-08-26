import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error Application code uses bundler resolution.
import { loadComputerUseEnabled, saveComputerUseEnabled } from './computer-use-state.ts'

function fixture(): { file: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), 'boss-computer-use-state-'))
  return {
    file: join(directory, 'computer-use.json'),
    cleanup: () => rmSync(directory, { recursive: true, force: true })
  }
}

test('computer use defaults off when no valid preference exists', () => {
  const { file, cleanup } = fixture()
  try {
    assert.equal(loadComputerUseEnabled(file), false)
    writeFileSync(file, '{ not json')
    assert.equal(loadComputerUseEnabled(file), false)
    writeFileSync(file, JSON.stringify({ version: 1, enabled: 'yes' }))
    assert.equal(loadComputerUseEnabled(file), false)
  } finally {
    cleanup()
  }
})

test('computer use enable and disable choices survive a new reader', () => {
  const { file, cleanup } = fixture()
  try {
    saveComputerUseEnabled(file, true)
    assert.equal(loadComputerUseEnabled(file), true)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { version: 1, enabled: true })

    saveComputerUseEnabled(file, false)
    assert.equal(loadComputerUseEnabled(file), false)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { version: 1, enabled: false })
  } finally {
    cleanup()
  }
})
