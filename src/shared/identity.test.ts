import assert from 'node:assert/strict'
import test from 'node:test'
import { webcrypto } from 'node:crypto'
// Node's type-stripping test runner requires explicit extensions.
// @ts-expect-error Application code uses bundler resolution.
import { challengeExpired, challengeMessage, fromBase64Url, looksLikeKey, looksLikeSignature, newNonce, roomIdFor, roomIdForKey, toBase64Url, verifySignature, CHALLENGE_TTL_MS, type SigningCrypto } from './identity.ts'

// The tests generate and sign, which SigningCrypto deliberately does not
// cover — it is the verify-only slice the relay needs.
const crypto = webcrypto as unknown as SigningCrypto & {
  subtle: {
    generateKey(a: { name: string }, e: boolean, u: string[]): Promise<{ publicKey: object; privateKey: object }>
    exportKey(format: 'raw', key: object): Promise<ArrayBuffer>
    sign(a: { name: string }, key: object, data: Uint8Array): Promise<ArrayBuffer>
  }
}

async function keypair(): Promise<{ publicKey: Uint8Array; sign(m: Uint8Array): Promise<Uint8Array> }> {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  return {
    publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)),
    sign: async (message) => new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, message))
  }
}

/** Goes through the shared helper, so the tests check what the relay runs. */
async function verify(publicKey: Uint8Array, signature: Uint8Array, message: Uint8Array): Promise<boolean> {
  return verifySignature(crypto, toBase64Url(publicKey), toBase64Url(signature), message)
}

test('a peer proves it owns a room by signing the relay nonce', async () => {
  const owner = await keypair()
  const roomId = roomIdFor(await crypto.subtle.digest('SHA-256', owner.publicKey))
  const message = challengeMessage('nonce-1', roomId, 'desktop')
  assert.equal(await verify(owner.publicKey, await owner.sign(message), message), true)
})

test('someone who knows the room id but not the key cannot join', async () => {
  // This is the attack the old static proof allowed: an empty room could be
  // claimed by anyone who had seen its id go past on the wire.
  const owner = await keypair()
  const attacker = await keypair()
  const roomId = roomIdFor(await crypto.subtle.digest('SHA-256', owner.publicKey))
  const message = challengeMessage('nonce-1', roomId, 'desktop')

  // The attacker knows roomId and signs the same challenge, but with its key.
  const forged = await attacker.sign(message)
  assert.equal(await verify(owner.publicKey, forged, message), false)
})

test('a signature captured by the relay cannot be replayed on a new connection', async () => {
  // Every connection gets a fresh nonce, so a relay host that logs one
  // signature still cannot use it to impersonate the desktop later.
  const owner = await keypair()
  const roomId = roomIdFor(await crypto.subtle.digest('SHA-256', owner.publicKey))
  const captured = await owner.sign(challengeMessage('nonce-1', roomId, 'desktop'))
  const later = challengeMessage('nonce-2', roomId, 'desktop')
  assert.equal(await verify(owner.publicKey, captured, later), false)
})

test('a signature for one room cannot be replayed into another', async () => {
  const owner = await keypair()
  const mine = roomIdFor(await crypto.subtle.digest('SHA-256', owner.publicKey))
  const signature = await owner.sign(challengeMessage('nonce-1', mine, 'desktop'))
  const other = challengeMessage('nonce-1', 'some-other-room', 'desktop')
  assert.equal(await verify(owner.publicKey, signature, other), false)
})

test('a desktop signature cannot be replayed as a phone', async () => {
  // Otherwise a paired phone could evict the desktop it is paired with.
  const owner = await keypair()
  const roomId = roomIdFor(await crypto.subtle.digest('SHA-256', owner.publicKey))
  const asDesktop = await owner.sign(challengeMessage('nonce-1', roomId, 'desktop'))
  const asPhone = challengeMessage('nonce-1', roomId, 'phone')
  assert.equal(await verify(owner.publicKey, asDesktop, asPhone), false)
})

test('the room id is stable for a key and different for another', async () => {
  const a = await keypair()
  const b = await keypair()
  const idA = roomIdFor(await crypto.subtle.digest('SHA-256', a.publicKey))
  assert.equal(idA, roomIdFor(await crypto.subtle.digest('SHA-256', a.publicKey)))
  assert.notEqual(idA, roomIdFor(await crypto.subtle.digest('SHA-256', b.publicKey)))
  assert.match(idA, /^[A-Za-z0-9_-]+$/)
})

test('the room id reveals nothing about the private key', async () => {
  // It is a truncated hash of the PUBLIC key, which is safe to publish.
  const owner = await keypair()
  const id = roomIdFor(await crypto.subtle.digest('SHA-256', owner.publicKey))
  assert.doesNotMatch(id, new RegExp(toBase64Url(owner.publicKey).slice(0, 12)))
})

test('malformed keys and signatures are rejected before any work is done', () => {
  assert.equal(looksLikeKey('too-short'), false)
  assert.equal(looksLikeKey('!'.repeat(43)), false)
  assert.equal(looksLikeKey('a'.repeat(43)), true)
  assert.equal(looksLikeSignature('a'.repeat(43)), false)
  assert.equal(looksLikeSignature('a'.repeat(86)), true)
  assert.equal(looksLikeKey(undefined), false)
  assert.equal(looksLikeSignature(null), false)
})

test('a real key and signature satisfy the validators', async () => {
  const owner = await keypair()
  const signature = await owner.sign(challengeMessage('n', 'r', 'desktop'))
  assert.equal(looksLikeKey(toBase64Url(owner.publicKey)), true)
  assert.equal(looksLikeSignature(toBase64Url(signature)), true)
})

test('a stale challenge is refused', () => {
  const issuedAt = 1_000_000
  assert.equal(challengeExpired({ nonce: 'n', issuedAt }, issuedAt + 1_000), false)
  assert.equal(challengeExpired({ nonce: 'n', issuedAt }, issuedAt + CHALLENGE_TTL_MS + 1), true)
})

test('base64url round-trips the bytes the wire carries', () => {
  const bytes = crypto.getRandomValues(new Uint8Array(64))
  assert.deepEqual(Array.from(fromBase64Url(toBase64Url(bytes))), Array.from(bytes))
  assert.doesNotMatch(toBase64Url(bytes), /[+/=]/)
})

test('the relay derives the room from the key, not from what the caller claims', async () => {
  // A peer sends only its public key. If the relay took a room id from the
  // frame instead, knowing an id would again be enough to join.
  const owner = await keypair()
  const claimed = await roomIdForKey(crypto, toBase64Url(owner.publicKey))
  assert.equal(claimed, roomIdFor(await crypto.subtle.digest('SHA-256', owner.publicKey)))

  const other = await keypair()
  assert.notEqual(claimed, await roomIdForKey(crypto, toBase64Url(other.publicKey)))
})

test('nonces do not repeat', () => {
  const seen = new Set(Array.from({ length: 200 }, () => newNonce(crypto)))
  assert.equal(seen.size, 200, 'a repeated nonce would make a signature replayable')
})

test('garbage is refused without throwing', async () => {
  // The relay must treat a malformed proof as a failed join, not a crash.
  assert.equal(await verifySignature(crypto, 'not-a-key', 'not-a-signature', new Uint8Array([1])), false)
  assert.equal(await verifySignature(crypto, 'a'.repeat(43), 'b'.repeat(86), new Uint8Array([1])), false)
})
