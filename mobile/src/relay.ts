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
import { deriveDeviceId, deriveJoinProof, deriveKey, fromBase64Url, open as openSealed, seal, toBase64Url } from './crypto'

export interface RelayCredentials {
  relayUrl: string
  /** Long-lived room secret. Derives the transport key and the device id. */
  secret: string
  /** This device's own token, which the desktop can revoke alone. */
  token: string
  peerId: string
  /**
   * Set only while pairing. The desktop's room id and join proof come from the
   * QR code, because they derive from the room secret the phone does not have
   * yet — deriving them from the pairing secret instead puts the phone alone
   * in a room the desktop never sees. Both are dropped once paired, when
   * `secret` becomes the room secret and the phone derives them itself.
   */
  deviceId?: string
  joinProof?: string
}

export type RelayMessage =
  | { kind: 'request'; id: string; request: unknown; token: string }
  | { kind: 'response'; id: string; ok: true; result: unknown }
  | { kind: 'response'; id: string; ok: false; error: string }
  | { kind: 'event'; event: Record<string, unknown>; seq: number }
  | { kind: 'resume'; since: number; token: string }
  | { kind: 'resumed'; events: Array<{ event: Record<string, unknown>; seq: number }>; gap: boolean; seq: number }
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
      joinProof: payload.j,
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

    socket.onopen = async () => {
      // Read this.credentials rather than the value captured above: pairing
      // replaces it with the room secret, and a reconnect scheduled before
      // that would otherwise keep deriving keys from the spent pairing
      // secret and seal every frame with a key the desktop cannot open.
      const current = this.credentials
      // A socket superseded during pairing must not send on the new one's behalf.
      if (!current || this.socket !== socket) return
      this.key = deriveKey(current.secret)
      socket.send(
        JSON.stringify({
          type: 'hello',
          side: 'phone',
          deviceId: current.deviceId ?? deriveDeviceId(current.secret),
          peerId: current.peerId,
          proof: current.joinProof ?? deriveJoinProof(current.secret),
          v: 1
        })
      )
      this.attempt = 0
      this.ready = true
      if (this.pendingClaim) {
        await this.send({ kind: 'claim', secret: this.pendingClaim, label: 'iPhone' })
      } else if (current.token) {
        await this.send({ kind: 'resume', since: this.lastSeq, token: current.token })
      }
      this.handlers.onStateChange(this.state)
      // Only now can a request be sent. onPaired fires while the replacement
      // socket is still opening, so anything issued there would be rejected
      // outright with "Connecting…" and never retried.
      if (current.token) this.handlers.onReady()
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

  private async receive(raw: string): Promise<void> {
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }

    if (typeof frame.type === 'string' && frame.type !== 'frame') {
      if (frame.type === 'welcome' || frame.type === 'peer.online' || frame.type === 'peer.offline') {
        this.desktopOnline = frame.desktopOnline !== false
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
      const credentials: RelayCredentials = {
        relayUrl: this.credentials.relayUrl,
        secret: message.secret,
        token: message.token,
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
