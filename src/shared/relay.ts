/**
 * Wire protocol shared by the desktop client, the phone, and the relay.
 *
 * The relay is a dumb pipe. It routes by `deviceId` and never sees the pairing
 * secret, so every payload it forwards is an opaque `sealed` string. Only the
 * envelope fields it needs for routing stay in the clear.
 */

/** Relay-visible envelope. `sealed` is base64url AES-GCM ciphertext. */
export interface RelayFrame {
  /** Routing key. Derived from the pairing secret, so it leaks no secret material. */
  deviceId: string
  /** Which side sent this frame. The relay uses it to pick the other side. */
  from: RelaySide
  /** Per-connection sender id, so a desktop can answer the right phone. */
  peerId: string
  /**
   * Addressed recipient. A desktop sets this to answer one phone; leaving it
   * unset fans the frame out to every paired phone, which is how events flow.
   * A phone never sets it — its frames always go to the desktop.
   */
  to?: string
  /** base64url(iv) . base64url(ciphertext+tag) */
  sealed: string
}

export type RelaySide = 'desktop' | 'phone'

/** Control frames the relay itself answers. Never carries user content. */
export interface RelayControl {
  type: 'hello' | 'welcome' | 'peer.online' | 'peer.offline' | 'error'
  side?: RelaySide
  deviceId?: string
  peerId?: string
  message?: string
  /** Desktop presence, so a phone can say "desktop asleep" instead of hanging. */
  desktopOnline?: boolean
}

/** Decrypted payload. This is what the relay must never be able to read. */
export type RelayMessage =
  /** `token` is the phone's own device token, checked against the paired list. */
  | { kind: 'request'; id: string; request: unknown; token: string }
  | { kind: 'response'; id: string; ok: true; result: unknown }
  | { kind: 'response'; id: string; ok: false; error: string }
  /**
   * `seq` increases by one per event for the life of the desktop connection.
   * A phone tracks the last one it applied and asks for anything newer when it
   * reconnects, so sleeping through a burst does not silently lose it.
   */
  | { kind: 'event'; event: Record<string, unknown>; seq: number }
  /** Phone → desktop on reconnect: "send me everything after `since`". */
  | { kind: 'resume'; since: number; token: string }
  /**
   * Desktop → phone. `events` is what it still had buffered. `gap` is true when
   * the phone was away longer than the buffer, so the UI must refetch rather
   * than trust an incomplete stream.
   */
  | { kind: 'resumed'; events: Array<{ event: Record<string, unknown>; seq: number }>; gap: boolean; seq: number }
  | { kind: 'ping' }
  | { kind: 'claim'; secret: string; label?: string }
  | { kind: 'claimed'; secret: string; token: string; role: string }

/**
 * The slice of WebCrypto this module uses, declared locally so the file
 * compiles under both tsconfigs. The renderer has DOM types and the main
 * process does not, but `node:crypto`.webcrypto and the browser's
 * `window.crypto` both satisfy this shape.
 */
export interface CryptoLike {
  getRandomValues<T extends Uint8Array>(array: T): T
  subtle: {
    digest(algorithm: string, data: ArrayBufferView | ArrayBuffer): Promise<ArrayBuffer>
    importKey(
      format: 'raw',
      keyData: ArrayBufferView | ArrayBuffer,
      algorithm: { name: string },
      extractable: boolean,
      usages: string[]
    ): Promise<AesKey>
    encrypt(algorithm: { name: string; iv: ArrayBufferView | ArrayBuffer }, key: AesKey, data: ArrayBufferView | ArrayBuffer): Promise<ArrayBuffer>
    decrypt(algorithm: { name: string; iv: ArrayBufferView | ArrayBuffer }, key: AesKey, data: ArrayBufferView | ArrayBuffer): Promise<ArrayBuffer>
  }
}

/** Opaque handle to an imported AES key. */
export type AesKey = object

export const RELAY_PROTOCOL_VERSION = 1

/** Frames larger than this are dropped by the relay and by both clients. */
export const RELAY_MAX_FRAME_BYTES = 512_000

/**
 * A pairing payload, encoded into the QR code the desktop shows.
 * `s` is the one-time pairing secret and never reaches the relay.
 */
export interface PairingPayload {
  v: number
  /** Relay base URL, e.g. https://boss-relay.fly.dev */
  r: string
  /** Device id (routing key). */
  d: string
  /** One-time pairing secret, base64url. */
  s: string
}

/**
 * Encode a pairing code as an ordinary web URL pointing at the relay, which
 * also serves the phone page. A phone camera opens http(s) links and refuses
 * custom schemes like `boss://` with "no usable data found", so the scheme is
 * not cosmetic — it decides whether scanning works at all.
 *
 * The payload rides in the fragment. Browsers never send a fragment to the
 * server, so the one-time secret reaches the page without the relay seeing it,
 * even though the relay served that page.
 */
export function encodePairing(payload: PairingPayload): string {
  const json = JSON.stringify(payload)
  const encoded = toBase64Url(new TextEncoder().encode(json))
  const base = payload.r.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/+$/, '')
  return `${base}/#p=${encoded}`
}

/** Accepts the fragment form this version emits and the `?p=` form, so a code
 *  pasted from an older desktop still pairs. */
export function decodePairing(input: string): PairingPayload | null {
  const trimmed = input.trim()
  const match = /[#?&]p=([A-Za-z0-9_-]+)/.exec(trimmed)
  if (!match) return null
  try {
    const json = new TextDecoder().decode(fromBase64Url(match[1]))
    const parsed = JSON.parse(json) as PairingPayload
    if (parsed.v !== RELAY_PROTOCOL_VERSION) return null
    if (!parsed.r || !parsed.d || !parsed.s) return null
    return parsed
  } catch {
    return null
  }
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
 * Both sides derive the same AES key from the pairing secret. The relay is
 * given only `deviceId`, which is a separate one-way derivation of the same
 * secret, so holding a device id does not let the relay derive the key.
 */
export async function deriveKey(crypto: CryptoLike, secret: string): Promise<AesKey> {
  return importAes(crypto, await digest(crypto, `boss-relay-key:${secret}`))
}



async function digest(crypto: CryptoLike, input: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
}

async function importAes(crypto: CryptoLike, raw: ArrayBuffer): Promise<AesKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

export async function seal(crypto: CryptoLike, key: AesKey, message: RelayMessage): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plaintext = new TextEncoder().encode(JSON.stringify(message))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)
  return `${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ciphertext))}`
}

export async function open(crypto: CryptoLike, key: AesKey, sealed: string): Promise<RelayMessage | null> {
  const [ivPart, bodyPart] = sealed.split('.')
  if (!ivPart || !bodyPart) return null
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64Url(ivPart) },
      key,
      fromBase64Url(bodyPart)
    )
    return JSON.parse(new TextDecoder().decode(plaintext)) as RelayMessage
  } catch {
    // A wrong key, a truncated frame, or a tampered tag all land here. The
    // caller treats null as "not from my peer" and drops the frame.
    return null
  }
}

/** Backoff for the desktop's outbound socket. Capped so a long outage still reconnects promptly. */
export function reconnectDelay(attempt: number): number {
  const base = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6))
  return Math.round(base * (0.5 + Math.random() * 0.5))
}

export interface RemoteAccessStatus {
  enabled: boolean
  relayUrl: string
  /** Connection state of the desktop's outbound socket. */
  state: 'off' | 'connecting' | 'online' | 'error'
  error?: string
  /** Set while a pairing QR code is on screen. */
  pairing?: { code: string; expiresAt: number }
  devices: RemoteDevice[]
  /** Keys currently in the room that never paired. Usually empty. */
  unknown: UnknownDevice[]
}

export interface RemoteDevice {
  /**
   * The device's Ed25519 public key, base64url. This is the identity, not the
   * peerId: a phone picks a fresh random peerId every time it pairs, so keying
   * on it made one phone appear as a new device on each re-pair and made
   * Forget revoke only that single pairing. A key is the same phone forever,
   * so re-pairing updates this entry and Forget keeps it out for good.
   */
  id: string
  label: string
  pairedAt: number
  lastSeenAt?: number
  online: boolean
}

/**
 * A key seen in this desktop's room that has never completed pairing.
 *
 * Such a device can read nothing — every payload is sealed with a secret the
 * relay never sees — but until now the desktop could not even tell it was
 * there. Surfaced in settings so a room is inspectable, without a popup for
 * what is usually a stale reconnect.
 */
export interface UnknownDevice {
  /** Ed25519 public key, base64url. */
  id: string
  firstSeenAt: number
  lastSeenAt: number
}

/**
 * Stored form of a paired phone. `tokenHash` lets the desktop verify a phone
 * without keeping the token itself, so the config file on disk cannot be
 * replayed to impersonate a paired device.
 */
export interface StoredDevice extends RemoteDevice {
  tokenHash: string
}

export async function hashToken(crypto: CryptoLike, token: string): Promise<string> {
  return toBase64Url(new Uint8Array(await digest(crypto, `boss-relay-token:${token}`)))
}
