import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import test from 'node:test'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error Application code uses bundler resolution.
import { BinaryOverrides, findBackendExecutable, resolveBackendBin, setBinaryOverrideSource } from './backend-bin.ts'

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
    delete process.env.OPENCODE_BIN
    delete process.env.BOSS_OPENCODE_BIN
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

test('finds the installed CLI on PATH as an absolute path', () => {
  withTempDir((dir) => {
    const empty = join(dir, 'empty')
    const bin = join(dir, 'bin')
    mkdirSync(empty)
    mkdirSync(bin)
    const codex = shim(bin, 'codex')
    assert.equal(findBackendExecutable('codex', [empty, bin].join(delimiter)), codex)
  })
})

test('skips a PATH entry that is not executable', () => {
  withTempDir((dir) => {
    const first = join(dir, 'first')
    const second = join(dir, 'second')
    mkdirSync(first)
    mkdirSync(second)
    // A stray file with the right name must not shadow the real install behind it.
    writeFileSync(join(first, 'codex'), 'not a program')
    const codex = shim(second, 'codex')
    assert.equal(findBackendExecutable('codex', [first, second].join(delimiter)), codex)
  })
})

test('prefers an override to PATH and reports a missing CLI as undefined', () => {
  withTempDir((dir) => {
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    shim(bin, 'codex')
    const pinned = shim(dir, 'pinned-codex')
    process.env.BOSS_CODEX_BIN = pinned
    assert.equal(findBackendExecutable('codex', bin), pinned)
    delete process.env.BOSS_CODEX_BIN
    assert.equal(findBackendExecutable('codex', join(dir, 'nowhere')), undefined)
  })
})

test('OPENCODE_BIN resolves opencode the same way for the probe and the server', () => {
  withTempDir((dir) => {
    // Settings probes resolveBackendBin('opencode') and the server spawns it, so the
    // older variable must count here or a working server shows as unavailable.
    const legacy = shim(dir, 'legacy-opencode')
    const current = shim(dir, 'boss-opencode')
    process.env.OPENCODE_BIN = legacy
    process.env.BOSS_OPENCODE_BIN = current
    assert.equal(resolveBackendBin('opencode'), legacy)
    assert.equal(resolveBackendBin('codex'), 'codex', 'OPENCODE_BIN applies to opencode only')
  })
})
