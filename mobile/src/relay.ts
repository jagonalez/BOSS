/**
 * Relay transport for the native app.
 *
 * Speaks the same wire protocol as the desktop and the web page — see
 * src/shared/relay.ts, which is the source of truth. This file is the React
 * Native binding for it: WebCrypto via expo-crypto's global, a socket that
 * survives backgrounding, and credentials in the Keychain rather than
 * localStorage.
 *
 * The relay only ever sees ciphertext. Nothing here sends a plaintext frame.
 */
import * as SecureStore from 'expo-secure-store'
import { deriveKey, fromBase64Url, newSecretKey, open as openSealed, publicKeyOf, seal, signChallenge, toBase64Url } from './crypto'

export interface RelayCredentials {
  relayUrl: string
  /** Long-lived room secret. Derives the transport key and the device id. */
  secret: string
  /** This device's own token, which the desktop can revoke alone. */
  token: string
  peerId: string
  /**
   * The room this phone belongs to: the hash of the DESKTOP's public key, read
   * from the QR code. A phone cannot compute it — that is the point. It proves
   * only that it is itself, and the desktop decides whether that identity is
   * allowed in.
   */
  deviceId?: string
  /**
   * This phone's own Ed25519 secret key, base64url. Generated on this device at
   * pairing and never transmitted; the relay sees only the public half and
   * signatures over nonces it issued. Held in the Keychain with the rest of the
   * credentials.
   */
  secretKey?: string
}

export type RelayMessage =
  | { kind: 'request'; id: string; request: unknown; token: string }
  | { kind: 'response'; id: string; ok: true; result: unknown }
  | { kind: 'response'; id: string; ok: false; error: string }
  | { kind: 'event'; event: Record<string, unknown>; seq: number }
  | { kind: 'resume'; since: number; token: string }
  | { kind: 'resumed'; events: Array<{ event: Record<string, unknown>; seq: number }>; gap: boolean; seq: number }
  /** One slice of a response too big for a single frame. See the desktop's
   *  src/shared/relay.ts, which this type must keep matching. */
  | { kind: 'chunk'; id: string; index: number; total: number; body: string }
  | { kind: 'ping' }
  | { kind: 'claim'; secret: string; label?: string }
  | { kind: 'claimed'; secret: string; token: string; role: string }

const CREDENTIALS_KEY = 'boss.relay.credentials'
const SEQ_KEY = 'boss.relay.seq'
/** A request waits this long before the UI reports the desktop unreachable. */
const REQUEST_TIMEOUT_MS = 20_000

/** Parse the payload a QR code carries, in either the fragment or query form. */
export function decodePairing(input: string): { v: number; r: string; d: string; s: string; j?: string } | null {
  const match = /[#?&]p=([A-Za-z0-9_-]+)/.exec(input.trim())
  if (!match) return null
  try {
    const parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(match[1])))
    if (parsed.v !== 1 || !parsed.r || !parsed.s) return null
    return parsed
  } catch {
    return null
  }
}

export async function loadCredentials(): Promise<RelayCredentials | null> {
  try {
    const raw = await SecureStore.getItemAsync(CREDENTIALS_KEY)
    return raw ? (JSON.parse(raw) as RelayCredentials) : null
  } catch {
    return null
  }
}

export async function saveCredentials(credentials: RelayCredentials): Promise<void> {
  await SecureStore.setItemAsync(CREDENTIALS_KEY, JSON.stringify(credentials))
}

export async function clearCredentials(): Promise<void> {
  await SecureStore.deleteItemAsync(CREDENTIALS_KEY).catch(() => {})
}

export interface RelayHandlers {
  onEvent(event: Record<string, unknown>): void
  /** The desktop could not replay far enough back; reload state instead. */
  onGap(): void
  onStateChange(state: RelayState): void
  onPaired(credentials: RelayCredentials): void
  /** The socket is open and the hello is sent: safe to issue requests. */
  onReady(): void
}

export interface RelayState {
  connected: boolean
  desktopOnline: boolean
  error?: string
}

/** Backoff matching the desktop's, so a relay restart does not stampede. */
function reconnectDelay(attempt: number): number {
  const base = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6))
  return Math.round(base * (0.5 + Math.random() * 0.5))
}

export class RelayConnection {
  private socket: WebSocket | null = null
  private key: Uint8Array | null = null
  private credentials: RelayCredentials | null = null
  private pendingClaim: string | null = null
  /** Chunks of responses still arriving, keyed by request id. */
  private readonly chunks = new Map<string, { parts: string[]; have: number; total: number }>()
  private attempt = 0
  private ready = false
  private desktopOnline = false
  private closing = false
  private lastSeq = 0
  private nextId = 1
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >()

  constructor(private readonly handlers: RelayHandlers) {}

  get state(): RelayState {
    return { connected: this.ready, desktopOnline: this.desktopOnline }
  }

  async start(credentials: RelayCredentials): Promise<void> {
    this.credentials = credentials
    this.lastSeq = Number((await SecureStore.getItemAsync(SEQ_KEY).catch(() => null)) ?? 0) || 0
    this.closing = false
    this.connect()
  }

  /** Begin pairing from a scanned QR payload. */
  async pair(payload: { r: string; s: string; d?: string; j?: string }): Promise<void> {
    this.credentials = {
      relayUrl: payload.r,
      secret: payload.s,
      token: '',
      deviceId: payload.d,
      // One keypair per phone, minted here and kept for the life of the
      // pairing, so the desktop can revoke this phone alone by its public key.
      secretKey: newSecretKey(),
      peerId: toBase64Url(crypto.getRandomValues(new Uint8Array(8)))
    }
    this.pendingClaim = payload.s
    this.closing = false
    this.connect()
  }

  stop(): void {
    this.closing = true
    this.ready = false
    this.socket?.close()
    this.socket = null
  }

  private connect(): void {
    const credentials = this.credentials
    if (!credentials || this.closing) return
    if (this.socket && this.socket.readyState <= 1) return

    // relayUrl is the one field pairing never replaces, so the checked local
    // is safe here. Everything else must be read live — see onopen below.
    const url = credentials.relayUrl.replace(/^http/, 'ws')
    const socket = new WebSocket(url)
    this.socket = socket

    // Nothing is sent on open. The relay speaks first with a nonce, and the
    // hello answers it — see greet(), driven from receive().
    socket.onopen = () => {
      this.attempt = 0
    }

    socket.onmessage = (raw) => {
      if (this.socket !== socket) return
      void this.receive(String(raw.data))
    }

    socket.onclose = () => {
      // Pairing deliberately closes this socket and opens a fresh one on the
      // room secret. close() is asynchronous, so this fires AFTER the
      // replacement exists — clearing this.socket then would orphan the live
      // connection and start a competing reconnect loop.
      if (this.socket !== socket) return
      this.ready = false
      this.socket = null
      this.handlers.onStateChange(this.state)
      if (!this.closing) setTimeout(() => this.connect(), reconnectDelay(this.attempt++))
    }

    socket.onerror = () => {
      /* onclose follows and schedules the retry. */
    }
  }

  /**
   * Answer the relay's challenge.
   *
   * The room is the desktop's, so its id comes from the QR code rather than
   * from anything this phone can compute. The signature is this phone's own:
   * it proves which phone is asking, not that it may enter. The desktop makes
   * that call when it sees the claim.
   */
  private greet(nonce: string): void {
    const socket = this.socket
    const current = this.credentials
    if (!socket || !current || socket.readyState !== 1) return
    // Read this.credentials rather than a captured local: pairing replaces it
    // with the room secret, and a reconnect scheduled before that would keep
    // deriving keys from the spent pairing secret and seal every frame with a
    // key the desktop cannot open.
    this.key = deriveKey(current.secret)
    const deviceId = current.deviceId
    const secretKey = current.secretKey
    if (!deviceId || !secretKey) return
    socket.send(
      JSON.stringify({
        type: 'hello',
        side: 'phone',
        // The desktop's room, from the QR code. A phone cannot derive it, so it
        // names it and signs it; the relay verifies the signature covers this
        // exact room, which stops a phone being redirected into another one.
        deviceId,
        peerId: current.peerId,
        publicKey: publicKeyOf(secretKey),
        signature: signChallenge(secretKey, nonce, deviceId, 'phone'),
        v: 1
      })
    )
  }

  /** The relay let this socket into the room. Now the desktop can be addressed. */
  private async admitted(): Promise<void> {
    const current = this.credentials
    if (!current) return
    this.ready = true
    if (this.pendingClaim) {
      await this.send({ kind: 'claim', secret: this.pendingClaim, label: 'iPhone' })
    } else if (current.token) {
      await this.send({ kind: 'resume', since: this.lastSeq, token: current.token })
    }
    // Only now can a request be sent. onPaired fires while the replacement
    // socket is still opening, so anything issued there would be rejected
    // outright with "Connecting…" and never retried.
    if (current.token) this.handlers.onReady()
  }

  private async receive(raw: string): Promise<void> {
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }

    // The relay opens with a nonce. Answering it proves this phone holds its
    // own private key, and nothing sent here is reusable on another connection.
    if (frame.type === 'challenge' && typeof frame.nonce === 'string') {
      this.greet(frame.nonce)
      return
    }

    if (typeof frame.type === 'string' && frame.type !== 'frame') {
      if (frame.type === 'welcome' || frame.type === 'peer.online' || frame.type === 'peer.offline') {
        this.desktopOnline = frame.desktopOnline !== false
        // Only a welcome means the relay accepted the signature. Claiming or
        // resuming before it would send into a socket about to be closed.
        if (frame.type === 'welcome') await this.admitted()
        this.handlers.onStateChange(this.state)
      }
      return
    }
    if (typeof frame.sealed !== 'string' || !this.key) return

    const message = openSealed<RelayMessage>(this.key, frame.sealed)
    if (!message) return

    if (message.kind === 'response') {
      const waiter = this.pending.get(message.id)
      if (!waiter) return
      clearTimeout(waiter.timer)
      this.pending.delete(message.id)
      if (message.ok) waiter.resolve(message.result)
      else waiter.reject(new Error(message.error))
      return
    }

    if (message.kind === 'chunk') {
      this.collect(message)
      return
    }

    if (message.kind === 'event') {
      await this.noteSeq(message.seq)
      this.handlers.onEvent(message.event)
      return
    }

    if (message.kind === 'resumed') {
      if (message.gap) {
        await this.noteSeq(message.seq)
        this.handlers.onGap()
      } else {
        for (const entry of message.events) {
          await this.noteSeq(entry.seq)
          this.handlers.onEvent(entry.event)
        }
      }
      return
    }

    if (message.kind === 'claimed' && this.credentials) {
      // Swap the one-time pairing secret for the long-lived credentials.
      // Everything but the secret and token survives: the room id and this
      // phone's keypair are what get it back into the room on the next
      // connect, and it can derive neither of them again.
      const credentials: RelayCredentials = {
        relayUrl: this.credentials.relayUrl,
        secret: message.secret,
        token: message.token,
        deviceId: this.credentials.deviceId,
        secretKey: this.credentials.secretKey,
        peerId: this.credentials.peerId
      }
      await saveCredentials(credentials)
      this.credentials = credentials
      this.pendingClaim = null
      // Detach before closing. The handlers are keyed on socket identity, so
      // clearing this.socket first makes the old socket's onclose a no-op and
      // stops it from tearing down the replacement opened on the next line.
      const previous = this.socket
      this.socket = null
      this.key = null
      this.ready = false
      previous?.close()
      this.handlers.onPaired(credentials)
      this.connect()
    }
  }

  /**
   * Gather one response's chunks and settle its request when the last arrives.
   *
   * Chunks are indexed rather than appended in arrival order, so nothing
   * depends on the socket delivering them in sequence. The waiter is only
   * resolved once every index is present; a chunk that never comes leaves the
   * request to time out like any other, which is the honest outcome — half a
   * transcript that parses is worse than one that visibly failed.
   */
  private collect(message: Extract<RelayMessage, { kind: 'chunk' }>): void {
    const waiter = this.pending.get(message.id)
    // Nothing is waiting: a late chunk for a request that already timed out.
    if (!waiter) { this.chunks.delete(message.id); return }

    let entry = this.chunks.get(message.id)
    if (!entry) {
      entry = { parts: new Array<string>(message.total), have: 0, total: message.total }
      this.chunks.set(message.id, entry)
    }
    if (entry.parts[message.index] === undefined) {
      entry.parts[message.index] = message.body
      entry.have++
    }
    if (entry.have < entry.total) return

    this.chunks.delete(message.id)
    clearTimeout(waiter.timer)
    this.pending.delete(message.id)
    try {
      // atob gives bytes as a binary string; the payload is UTF-8 and full of
      // characters that are not one byte, so it has to be decoded as such.
      const binary = atob(entry.parts.join(''))
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
      const json = new TextDecoder().decode(bytes)
      const payload = JSON.parse(json) as { ok: boolean; result?: unknown; error?: string }
      if (payload.ok) waiter.resolve(payload.result)
      else waiter.reject(new Error(payload.error ?? 'Request failed.'))
    } catch {
      waiter.reject(new Error('That response arrived incomplete. Pull to refresh.'))
    }
  }

  private async noteSeq(seq: number): Promise<void> {
    if (typeof seq !== 'number' || seq <= this.lastSeq) return
    this.lastSeq = seq
    await SecureStore.setItemAsync(SEQ_KEY, String(seq)).catch(() => {})
  }

  private async send(message: RelayMessage): Promise<boolean> {
    if (!this.socket || !this.key || this.socket.readyState !== 1) return false
    this.socket.send(JSON.stringify({ sealed: seal(this.key, message) }))
    return true
  }

  /** Issue a BackendRequest and wait for the desktop's answer. */
  request<T>(request: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const credentials = this.credentials
      if (!this.ready || !credentials?.token) {
        reject(new Error(this.desktopOnline ? 'Connecting…' : 'Your desktop is offline.'))
        return
      }
      const id = String(this.nextId++)
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(this.desktopOnline ? 'The desktop did not answer.' : 'Your desktop is offline.'))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      void this.send({ kind: 'request', id, request, token: credentials.token }).then((sent) => {
        if (sent) return
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error('Not connected to the relay.'))
      })
    })
  }

  /** Called when the app returns to the foreground. */
  resume(): void {
    if (!this.credentials?.token) return
    if (!this.socket || this.socket.readyState > 1) this.connect()
    else if (this.ready) void this.send({ kind: 'resume', since: this.lastSeq, token: this.credentials.token })
  }
}
