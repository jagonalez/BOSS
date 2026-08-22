import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

/**
 * An action that signs a device out, or invalidates a token every phone is holding, cannot be one
 * click. These read the source rather than render the tree: the components pull in the app store
 * and Electron, and what is worth pinning is that each of these calls goes through a confirm at
 * all — not how React draws it.
 */
const mobile = readFileSync(join(import.meta.dirname, 'MobileSettings.tsx'), 'utf8')

/** Every mutation that cannot be undone, and the word the button carries. */
const DESTRUCTIVE = ['revokeAll: true', 'regenerateToken: true', 'regenerateViewerToken: true']

test('a destructive remote-access action asks first', () => {
  for (const call of DESTRUCTIVE) {
    const at = mobile.indexOf(call)
    assert.ok(at > 0, `expected to find ${call}`)
    // The call should sit inside a confirm's action, so the nearest onClick above it opens one.
    const before = mobile.slice(Math.max(0, at - 700), at)
    const onClick = before.lastIndexOf('onClick')
    assert.ok(onClick >= 0, `${call} should be reached from a button`)
    assert.ok(
      before.slice(onClick).includes('confirm:'),
      `${call} fires straight from its button; it should open a confirm first`
    )
  }
})

test('a destructive confirm is marked destructive and says what is lost', () => {
  for (const call of DESTRUCTIVE) {
    const at = mobile.indexOf(call)
    const block = mobile.slice(Math.max(0, at - 700), at)
    const start = block.lastIndexOf('confirm:')
    assert.ok(block.slice(start).includes('destructive: true'), `${call} should be styled as destructive`)
    const message = /message: '([^']+)'/.exec(block.slice(start))?.[1] ?? ''
    // A message that only restates the button teaches nothing; these have to name the consequence.
    assert.ok(message.length > 40, `${call} should explain what is lost, got: ${message}`)
  }
})

test('revoking one paired device asks too', () => {
  // The per-device button is the same action at smaller scale, so it takes the same confirm.
  const at = mobile.indexOf('forgetDeviceId: device.id')
  const before = mobile.slice(Math.max(0, at - 700), at)
  assert.ok(before.slice(before.lastIndexOf('onClick')).includes('confirm:'), 'revoking a device should ask first')
})

test('blocking an unrecognized device stays one click', () => {
  // Blocking is protective rather than destructive: it removes a key that never paired and can
  // read nothing. Friction here would discourage the safe action.
  const last = mobile.lastIndexOf('forgetDeviceId: device.id')
  const before = mobile.slice(Math.max(0, last - 400), last)
  assert.ok(!before.slice(before.lastIndexOf('onClick')).includes('confirm:'), 'blocking should not ask')
})
