import { strictEqual } from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, describe, test } from 'node:test'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error Application code uses bundler resolution.
import { installAt, linkKind, statusFor, uninstallAt } from './cli-install.ts'

const root = mkdtempSync(join(tmpdir(), 'boss-cli-install-'))
after(() => rmSync(root, { recursive: true, force: true }))

let seq = 0
let bin: string
let link: string
let shim: string

beforeEach(() => {
  seq += 1
  const dir = join(root, `case-${seq}`)
  bin = join(dir, 'bin')
  const bundle = join(dir, 'BOSS.app', 'Contents', 'Resources', 'cli')
  mkdirSync(bin, { recursive: true })
  mkdirSync(bundle, { recursive: true })
  link = join(bin, 'boss')
  shim = join(bundle, 'boss')
  writeFileSync(shim, '#!/bin/sh\n')
})

describe('installAt', () => {
  test('creates a symlink pointing at the shim', () => {
    const status = installAt(link, shim, true)
    strictEqual(status.installed, true)
    strictEqual(status.conflict, false)
    strictEqual(status.error, undefined)
    strictEqual(readlinkSync(link), shim)
  })

  test('is idempotent', () => {
    installAt(link, shim, true)
    const status = installAt(link, shim, true)
    strictEqual(status.installed, true)
    strictEqual(readlinkSync(link), shim)
  })

  // The bundle moved — /Applications to a second disk, or a rename. The old
  // link is dead but still ours, so installing repoints it rather than failing.
  test('repoints a link left by a bundle that moved', () => {
    const stale = join(root, `case-${seq}`, 'Old', 'BOSS.app', 'Contents', 'Resources', 'cli', 'boss')
    symlinkSync(stale, link)
    const status = installAt(link, shim, true)
    strictEqual(status.installed, true)
    strictEqual(readlinkSync(link), shim)
  })

  test('refuses to replace a command that is not ours', () => {
    writeFileSync(link, '#!/bin/sh\necho not boss\n')
    const status = installAt(link, shim, true)
    strictEqual(status.installed, false)
    strictEqual(status.conflict, true)
    strictEqual(typeof status.error, 'string')
  })

  test('refuses to replace a symlink to someone else', () => {
    const other = join(root, `case-${seq}`, 'other-tool')
    writeFileSync(other, '#!/bin/sh\n')
    symlinkSync(other, link)
    const status = installAt(link, shim, true)
    strictEqual(status.conflict, true)
    strictEqual(readlinkSync(link), other)
  })

  test('reports a build with no shim instead of linking nothing', () => {
    const status = installAt(link, '', false)
    strictEqual(status.installed, false)
    strictEqual(status.available, false)
    strictEqual(typeof status.error, 'string')
  })
})

describe('uninstallAt', () => {
  test('removes our link', () => {
    installAt(link, shim, true)
    const status = uninstallAt(link, shim, true)
    strictEqual(status.installed, false)
    strictEqual(linkKind(link, shim), 'absent')
  })

  test('leaves a foreign command alone', () => {
    writeFileSync(link, '#!/bin/sh\necho not boss\n')
    uninstallAt(link, shim, true)
    strictEqual(linkKind(link, shim), 'foreign')
  })

  test('is quiet when nothing is installed', () => {
    const status = uninstallAt(link, shim, true)
    strictEqual(status.installed, false)
    strictEqual(status.error, undefined)
  })
})

describe('statusFor', () => {
  test('an unpackaged build is not available even with a shim present', () => {
    const status = statusFor(link, shim, false)
    strictEqual(status.available, false)
  })

  test('reports the paths it is talking about', () => {
    const status = statusFor(link, shim, true)
    strictEqual(status.path, link)
    strictEqual(status.target, shim)
    strictEqual(status.available, true)
  })
})
