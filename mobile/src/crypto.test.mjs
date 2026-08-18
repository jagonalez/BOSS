/**
 * Does the phone's pure-JS crypto agree with the desktop's WebCrypto?
 *
 * If it does not, the app pairs and then silently drops every frame — the
 * exact failure mode that cost a whole evening once already. So this compares
 * against real WebCrypto output rather than against itself.
 *
 * Run: node --experimental-strip-types src/crypto.test.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { webcrypto } from 'node:crypto'
import { gcm } from '@noble/ciphers/aes.js'
import { sha256 } from '@noble/hashes/sha2.js'

const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const unb64u = (s) => {
  const t = s.replace(/-/g, '+').replace(/_/g, '/')
  return new Uint8Array(Buffer.from(t + '='.repeat((4 - (t.length % 4)) % 4), 'base64'))
}

const SECRET = 'a-shared-room-secret-for-the-test'

test('SHA-256 derivations match WebCrypto exactly', async () => {
  for (const prefix of ['boss-relay-key:', 'boss-relay-device:', 'boss-relay-join:']) {
    const input = new TextEncoder().encode(prefix + SECRET)
    const viaWebCrypto = new Uint8Array(await webcrypto.subtle.digest('SHA-256', input))
    const viaNoble = sha256(input)
    assert.deepEqual(Array.from(viaNoble), Array.from(viaWebCrypto), prefix)
  }
})

test('the device id and join proof match what the desktop computes', async () => {
  const desktopId = b64u(new Uint8Array(
    await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode('boss-relay-device:' + SECRET))
  ).slice(0, 16))
  const phoneId = b64u(sha256(new TextEncoder().encode('boss-relay-device:' + SECRET)).slice(0, 16))
  assert.equal(phoneId, desktopId, 'a mismatch puts the phone in a room of its own')
})

test('the phone opens a frame the desktop sealed', async () => {
  // Desktop side: WebCrypto.
  const raw = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode('boss-relay-key:' + SECRET))
  const webKey = await webcrypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  const iv = webcrypto.getRandomValues(new Uint8Array(12))
  const message = { kind: 'event', event: { type: 'message.updated' }, seq: 4 }
  const cipher = new Uint8Array(await webcrypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, webKey, new TextEncoder().encode(JSON.stringify(message))
  ))

  // Phone side: @noble.
  const nobleKey = sha256(new TextEncoder().encode('boss-relay-key:' + SECRET))
  const opened = gcm(nobleKey, iv).decrypt(cipher)
  assert.deepEqual(JSON.parse(new TextDecoder().decode(opened)), message)
})

test('the desktop opens a frame the phone sealed', async () => {
  const nobleKey = sha256(new TextEncoder().encode('boss-relay-key:' + SECRET))
  const iv = webcrypto.getRandomValues(new Uint8Array(12))
  const message = { kind: 'claim', secret: 'one-time', label: 'iPhone' }
  const sealed = gcm(nobleKey, iv).encrypt(new TextEncoder().encode(JSON.stringify(message)))

  const raw = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode('boss-relay-key:' + SECRET))
  const webKey = await webcrypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  const opened = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv }, webKey, sealed)
  assert.deepEqual(JSON.parse(new TextDecoder().decode(opened)), message)
})

test('a wrong key yields nothing, so the relay stays blind', () => {
  const mine = sha256(new TextEncoder().encode('boss-relay-key:' + SECRET))
  const theirs = sha256(new TextEncoder().encode('boss-relay-key:a-different-secret'))
  const iv = webcrypto.getRandomValues(new Uint8Array(12))
  const sealed = gcm(mine, iv).encrypt(new TextEncoder().encode('{"kind":"ping"}'))
  assert.throws(() => gcm(theirs, iv).decrypt(sealed))
})

test('base64url round-trips the way the wire format needs', () => {
  const bytes = webcrypto.getRandomValues(new Uint8Array(32))
  assert.deepEqual(Array.from(unb64u(b64u(bytes))), Array.from(bytes))
  assert.doesNotMatch(b64u(bytes), /[+/=]/, 'base64url must not contain +, / or =')
})

test('a reconnect after pairing must use the ROOM secret, not the pairing one', async () => {
  // The bug this guards: connect() captured `credentials` in a local, so a
  // reconnect scheduled before pairing completed kept deriving keys from the
  // spent pairing secret. The phone rejoined the right room — the id comes
  // from the QR code — and then sealed every frame with a key the desktop
  // could not open. It looked exactly like "Connecting…" forever.
  const pairingSecret = 'one-time-pairing-secret'
  const roomSecret = 'the-long-lived-room-secret'

  const pairingKey = sha256(new TextEncoder().encode('boss-relay-key:' + pairingSecret))
  const roomKey = sha256(new TextEncoder().encode('boss-relay-key:' + roomSecret))
  assert.notDeepEqual(Array.from(pairingKey), Array.from(roomKey), 'the two keys must differ')

  // What the desktop sends after pairing is sealed with the ROOM key.
  const iv = webcrypto.getRandomValues(new Uint8Array(12))
  const fromDesktop = gcm(roomKey, iv).encrypt(new TextEncoder().encode('{"kind":"ping"}'))

  // A phone still holding the pairing key sees nothing at all.
  assert.throws(() => gcm(pairingKey, iv).decrypt(fromDesktop),
    'a stale pairing key must fail loudly here rather than silently in the app')
  assert.deepEqual(
    JSON.parse(new TextDecoder().decode(gcm(roomKey, iv).decrypt(fromDesktop))),
    { kind: 'ping' }
  )
})
