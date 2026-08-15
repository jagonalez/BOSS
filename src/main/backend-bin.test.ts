import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error Application code uses bundler resolution.
import { BinaryOverrides, resolveBackendBin, setBinaryOverrideSource } from './backend-bin.ts'

/** A real executable at a path no PATH lookup would ever reach. */
function shim(dir: string, name: string): string {
  const path = join(dir, name)
  writeFileSync(path, '#!/bin/sh\necho ok\n')
  chmodSync(path, 0o755)
  return path
}

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'boss-backend-bin-'))
  try {
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    // Each test installs its own reader; leave the module as it was found.
    setBinaryOverrideSource(() => ({}))
    delete process.env.BOSS_CODEX_BIN
  }
}

test('resolves to the bare command when nothing is overridden', () => {
  withTempDir(() => {
    assert.equal(resolveBackendBin('codex'), 'codex')
  })
})

test('uses a stored override that exists on disk', () => {
  withTempDir((dir) => {
    const bin = shim(dir, 'my-codex')
    const overrides = new BinaryOverrides(join(dir, 'bins.json'))
    overrides.set('codex', bin)
    setBinaryOverrideSource(() => overrides.all())
    assert.equal(resolveBackendBin('codex'), bin)
  })
})

test('ignores an override that no longer exists', () => {
  withTempDir((dir) => {
    const overrides = new BinaryOverrides(join(dir, 'bins.json'))
    // A binary moved or uninstalled since the path was saved. Falling back to PATH
    // keeps a backend working that would otherwise break on a stale setting.
    overrides.set('codex', join(dir, 'gone'))
    setBinaryOverrideSource(() => overrides.all())
    assert.equal(resolveBackendBin('codex'), 'codex')
  })
})

test('lets the environment variable outrank a stored override', () => {
  withTempDir((dir) => {
    const fromEnv = shim(dir, 'env-codex')
    const fromSettings = shim(dir, 'settings-codex')
    const overrides = new BinaryOverrides(join(dir, 'bins.json'))
    overrides.set('codex', fromSettings)
    setBinaryOverrideSource(() => overrides.all())
    process.env.BOSS_CODEX_BIN = fromEnv
    assert.equal(resolveBackendBin('codex'), fromEnv)
  })
})

test('an empty path clears the override rather than storing a blank', () => {
  withTempDir((dir) => {
    const file = join(dir, 'bins.json')
    const overrides = new BinaryOverrides(file)
    overrides.set('codex', shim(dir, 'my-codex'))
    const remaining = overrides.set('codex', '   ')
    assert.deepEqual(remaining, {}, 'the entry is removed, not set to an empty string')
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {})
  })
})

test('reads back what a previous run wrote', () => {
  withTempDir((dir) => {
    const file = join(dir, 'bins.json')
    const bin = shim(dir, 'my-pi')
    new BinaryOverrides(file).set('pi', bin)
    assert.deepEqual(new BinaryOverrides(file).all(), { pi: bin }, 'a new instance sees the saved path')
  })
})

test('survives a corrupt or non-string settings file', () => {
  withTempDir((dir) => {
    const file = join(dir, 'bins.json')
    writeFileSync(file, '{ not json')
    assert.deepEqual(new BinaryOverrides(file).all(), {}, 'unreadable settings fall back to PATH')
    writeFileSync(file, JSON.stringify({ codex: 42, pi: '/bin/sh' }))
    assert.deepEqual(new BinaryOverrides(file).all(), { pi: '/bin/sh' }, 'non-string entries are dropped')
  })
})
