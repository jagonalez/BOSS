import assert from 'node:assert/strict'
import test from 'node:test'
import { webcrypto } from 'node:crypto'
// Node's type-stripping test runner requires explicit extensions.
// @ts-expect-error Application code uses bundler resolution.
import { decodePairing, deriveDeviceId, deriveJoinProof, deriveKey, encodePairing, open, reconnectDelay, seal, RELAY_PROTOCOL_VERSION, type CryptoLike } from './relay.ts'

const crypto = webcrypto as unknown as CryptoLike

test('a sealed message round-trips for the holder of the secret', async () => {
  const key = await deriveKey(crypto, 'secret-one')
  const message = { kind: 'request' as const, id: '1', request: { type: 'thread.list' }, token: 'device-token' }
  assert.deepEqual(await open(crypto, key, await seal(crypto, key, message)), message)
})

test('the relay cannot read a frame: a different secret decrypts to nothing', async () => {
  const mine = await deriveKey(crypto, 'secret-one')
  const theirs = await deriveKey(crypto, 'secret-two')
  const sealed = await seal(crypto, mine, { kind: 'event', event: { type: 'message.updated' }, seq: 1 })
  assert.equal(await open(crypto, theirs, sealed), null)
})

test('a tampered frame is rejected rather than silently accepted', async () => {
  const key = await deriveKey(crypto, 'secret-one')
  const sealed = await seal(crypto, key, { kind: 'ping' })
  const [iv, body] = sealed.split('.')
  // Flip a character in the ciphertext; AES-GCM's tag must catch it.
  const flipped = body[0] === 'A' ? `B${body.slice(1)}` : `A${body.slice(1)}`
  assert.equal(await open(crypto, key, `${iv}.${flipped}`), null)
})

test('every frame uses a fresh nonce, so identical messages differ on the wire', async () => {
  const key = await deriveKey(crypto, 'secret-one')
  const a = await seal(crypto, key, { kind: 'ping' })
  const b = await seal(crypto, key, { kind: 'ping' })
  assert.notEqual(a, b)
})

test('the device id and the join proof leak no secret and differ from each other', async () => {
  const deviceId = await deriveDeviceId(crypto, 'secret-one')
  const proof = await deriveJoinProof(crypto, 'secret-one')
  assert.notEqual(deviceId, proof)
  for (const value of [deviceId, proof]) {
    assert.doesNotMatch(value, /secret-one/)
    assert.match(value, /^[A-Za-z0-9_-]+$/)
  }
  // Derivation is stable, so a reconnect reaches the same room.
  assert.equal(await deriveDeviceId(crypto, 'secret-one'), deviceId)
  assert.notEqual(await deriveDeviceId(crypto, 'secret-two'), deviceId)
})

test('a pairing code round-trips through the QR payload', () => {
  const payload = { v: RELAY_PROTOCOL_VERSION, r: 'https://boss-relay.fly.dev', d: 'device-1', s: 'secret-1' }
  const decoded = decodePairing(encodePairing(payload))
  assert.deepEqual(decoded, payload)
})

test('the pairing code is a web URL a phone camera will open', () => {
  // A custom scheme such as boss:// makes iOS Camera report "no usable data
  // found" and refuse to hand the code to anything, so the scheme matters.
  const code = encodePairing({ v: RELAY_PROTOCOL_VERSION, r: 'wss://boss-relay.fly.dev', d: 'd1', s: 's1' })
  assert.match(code, /^https:\/\/boss-relay\.fly\.dev\/#p=/)
  assert.doesNotMatch(code, /^boss:/)
})

test('the secret rides in the fragment, which browsers never send to a server', () => {
  const code = encodePairing({ v: RELAY_PROTOCOL_VERSION, r: 'wss://relay.example', d: 'd1', s: 'the-secret' })
  const [beforeFragment, fragment] = code.split('#')
  // Everything the relay could log lives before the '#'.
  assert.doesNotMatch(beforeFragment, /p=/)
  assert.match(fragment, /^p=/)
  assert.deepEqual(decodePairing(code)?.s, 'the-secret')
})

test('a ws:// relay maps to http:// so a local test pairs too', () => {
  const code = encodePairing({ v: RELAY_PROTOCOL_VERSION, r: 'ws://192.168.1.84:8080', d: 'd1', s: 's1' })
  assert.match(code, /^http:\/\/192\.168\.1\.84:8080\/#p=/)
  assert.equal(decodePairing(code)?.r, 'ws://192.168.1.84:8080')
})

test('a malformed or wrong-version pairing code is refused', () => {
  assert.equal(decodePairing('not a pairing code'), null)
  assert.equal(decodePairing('boss://pair?p=!!!!'), null)
  const wrongVersion = encodePairing({ v: RELAY_PROTOCOL_VERSION + 1, r: 'https://r', d: 'd', s: 's' })
  assert.equal(decodePairing(wrongVersion), null)
})

test('reconnect backoff grows and then stays bounded', () => {
  // Delays are jittered, so assert the bounds rather than exact values.
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const delay = reconnectDelay(attempt)
    assert.ok(delay >= 250, `attempt ${attempt} waited ${delay}ms`)
    assert.ok(delay <= 30_000, `attempt ${attempt} waited ${delay}ms`)
  }
  const early = Array.from({ length: 40 }, () => reconnectDelay(0))
  const late = Array.from({ length: 40 }, () => reconnectDelay(8))
  assert.ok(Math.max(...early) < Math.min(...late), 'later attempts must wait longer')
})

test('pairing crosses two different secrets, so one key cannot serve both', async () => {
  // The bug this guards: the phone seals its claim with the ONE-TIME pairing
  // secret from the QR code, while the desktop holds the LONG-LIVED room
  // secret. Sealing and opening with the same secret — as every other test
  // here does — hides that completely, and QR pairing silently never worked.
  const roomSecret = 'the-long-lived-room-secret-abcdef'
  const pairingSecret = 'a-one-time-pairing-secret'

  const roomKey = await deriveKey(crypto, roomSecret)
  const pairingKey = await deriveKey(crypto, pairingSecret)

  // Phone → desktop: the claim is sealed with the pairing key.
  const claim = await seal(crypto, pairingKey, { kind: 'claim', secret: pairingSecret, label: 'iPhone' })
  assert.equal(await open(crypto, roomKey, claim), null, 'the room key must NOT open a claim')
  assert.deepEqual(await open(crypto, pairingKey, claim), {
    kind: 'claim', secret: pairingSecret, label: 'iPhone'
  })

  // Desktop → phone: the reply must also use the pairing key, because the
  // phone does not have the room secret until this message delivers it.
  const reply = await seal(crypto, pairingKey, {
    kind: 'claimed', secret: roomSecret, token: 'device-token', role: 'control'
  })
  assert.equal(await open(crypto, roomKey, reply), null, 'the phone cannot use the room key yet')
  const opened = await open(crypto, pairingKey, reply)
  assert.equal(opened?.kind === 'claimed' ? opened.secret : null, roomSecret)
})
