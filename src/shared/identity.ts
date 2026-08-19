/**
 * Who a peer is, proved by signature rather than by a shared token.
 *
 * The first design gave the relay a static "join proof" — a hash of the room
 * secret, sent on every connect. Three things were wrong with it:
 *
 *   - rooms were first-come-first-served, so an empty room could be claimed by
 *     anyone who knew its id, locking the real desktop out;
 *   - the proof was replayable, so a relay host that logged one could
 *     impersonate the desktop forever;
 *   - the QR code carried it, making a photographed code a permanent
 *     credential rather than a five-minute one.
 *
 * A keypair fixes all three. A room is named by the hash of its owner's public
 * key, so it is owned rather than claimed. The relay sends a nonce and the peer
 * signs it, so nothing replayable crosses the wire and a compromised relay
 * holds only public keys and spent nonces.
 *
 * Ed25519 because both sides already have it: node:crypto on the desktop and
 * the relay, @noble/curves on the phone. identity.test.ts checks the two
 * against each other rather than assuming they agree.
 */

/** Ed25519 signatures are 64 bytes and raw public keys are 32. */
export const SIGNATURE_BYTES = 64
export const PUBLIC_KEY_BYTES = 32

/**
 * How long a relay challenge stays valid. Long enough for a slow phone on a
 * bad connection, short enough that a captured nonce is worthless.
 */
export const CHALLENGE_TTL_MS = 30_000

export interface Challenge {
  /** Random per connection, so a signature cannot be replayed on another. */
  nonce: string
  issuedAt: number
}

/** What a peer sends to prove it holds the private key for `publicKey`. */
export interface JoinProof {
  /** base64url raw Ed25519 public key. */
  publicKey: string
  /** base64url signature over the relay's nonce. */
  signature: string
}

/**
 * A room is named by its owner's public key, so only the holder of the private
 * key can claim it. The relay derives this itself rather than trusting a
 * device id the caller supplies.
 */
export function roomIdFor(publicKeyHash: ArrayBuffer): string {
  return toBase64Url(new Uint8Array(publicKeyHash).slice(0, 16))
}

/**
 * What the peer actually signs. Binding the room and the side into the message
 * stops a signature for one room being replayed into another.
 */
export function challengeMessage(nonce: string, roomId: string, side: 'desktop' | 'phone'): Uint8Array {
  return new TextEncoder().encode(`boss-relay-join ${nonce} ${roomId} ${side}`)
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const base64 = typeof btoa === 'function' ? btoa(binary) : Buffer.from(bytes).toString('base64')
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  if (typeof atob === 'function') {
    const binary = atob(padded)
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
    return out
  }
  return new Uint8Array(Buffer.from(padded, 'base64'))
}

/**
 * Reject anything that is not a well-formed key or signature before spending
 * work on it, so a malformed frame costs the relay nothing.
 */
export function looksLikeKey(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
}

export function looksLikeSignature(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{86}$/.test(value)
}

export function challengeExpired(challenge: Challenge, now: number): boolean {
  return now - challenge.issuedAt > CHALLENGE_TTL_MS
}

/**
 * The slice of WebCrypto verification needs. Declared locally for the same
 * reason CryptoLike is in relay.ts: src/shared compiles under a tsconfig
 * without DOM types, and node:crypto's webcrypto satisfies this shape.
 */
export interface SigningCrypto {
  getRandomValues<T extends Uint8Array>(array: T): T
  subtle: {
    digest(algorithm: string, data: ArrayBufferView | ArrayBuffer): Promise<ArrayBuffer>
    importKey(
      format: 'raw',
      keyData: ArrayBufferView | ArrayBuffer,
      algorithm: { name: string },
      extractable: boolean,
      usages: string[]
    ): Promise<object>
    verify(
      algorithm: { name: string },
      key: object,
      signature: ArrayBufferView | ArrayBuffer,
      data: ArrayBufferView | ArrayBuffer
    ): Promise<boolean>
  }
}

export function newNonce(crypto: SigningCrypto): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(16)))
}

/** The room a public key owns. Derived from the key, never taken from the
 *  caller, so a peer cannot ask to join a room it has no key for. */
export async function roomIdForKey(crypto: SigningCrypto, publicKey: string): Promise<string> {
  return roomIdFor(await crypto.subtle.digest('SHA-256', fromBase64Url(publicKey)))
}

/** A malformed key or signature is a failed proof, not an error to raise. */
export async function verifySignature(
  crypto: SigningCrypto,
  publicKey: string,
  signature: string,
  message: Uint8Array
): Promise<boolean> {
  if (!looksLikeKey(publicKey) || !looksLikeSignature(signature)) return false
  try {
    const key = await crypto.subtle.importKey('raw', fromBase64Url(publicKey), { name: 'Ed25519' }, false, ['verify'])
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, fromBase64Url(signature), message)
  } catch {
    return false
  }
}
