import { webcrypto, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { BackendRequest } from '../shared/backend'
import { mobileRequestAllowed, type MobileAccessRole } from '../shared/mobile'
import { EventBuffer } from '../shared/event-buffer'
import {
  deriveKey,
  encodePairing,
  hashToken,
  open,
  reconnectDelay,
  seal,
  RELAY_MAX_FRAME_BYTES,
  RELAY_PROTOCOL_VERSION,
  type AesKey,
  type CryptoLike,
  type RelayMessage,
  type RemoteAccessStatus,
  type StoredDevice
} from '../shared/relay'
import { looksLikeKey, roomIdForKey, type SigningCrypto } from '../shared/identity'
import { RelayIdentity } from './relay-identity'

/**
 * Outbound half of remote access. The desktop dials the relay, so no inbound
 * port is opened and no firewall rule is needed.
 *
 * The trust boundary lives here, not on the relay. This process decrypts the
 * frame, applies the same allowlist the Tailscale path uses, and calls the
 * backend locally. Agent credentials never travel: the phone sends a request
 * name, and this machine performs it.
 */

const crypto = webcrypto as unknown as CryptoLike & SigningCrypto

/** Compare secret-derived values without leaking their contents through timing. */
function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/** Same scope as the loopback server: review and steer, never configure. */
const ALLOWED_REQUESTS = new Set<BackendRequest['type']>([
  'backend.list',
  'supervision.snapshot',
  'supervision.search',
  'supervision.acknowledge',
  'thread.list',
  'thread.get',
  'thread.messages',
  'thread.part',
  'thread.send',
  'thread.abort',
  'thread.todos',
  'thread.permission',
  'thread.diff',
  // Starting work, not just watching it. A paired phone can already send
  // messages into a running agent, so it can already cause the machine to act;
  // withholding these bought nothing and made the phone read-mostly.
  'thread.create',
  'thread.models',
  'thread.mode.set',
  'thread.archive',
  'thread.delegate',
  'thread.rename',
  'thread.delete',
  'automation.list',
  'automation.run',
  'automation.stop',
  'assistant.snapshot',
  'assistant.answer',
  'assistant.task.create',
  'assistant.task.update',
  'assistant.task.assign'
])

/** Ceiling on how many frames one response may take.
 *
 *  At ~384KB of payload per chunk this is 12MB, far past any transcript worth
 *  sending to a phone. It exists so a pathological result — a diff of a
 *  vendored tree, a tool that returned a binary — fails with a message instead
 *  of pushing hundreds of frames at a phone on cellular. */
const MAX_RESPONSE_CHUNKS = 32

const FORWARDED_EVENTS = new Set([
  'session.created',
  'session.updated',
  'session.deleted',
  'session.status',
  'session.idle',
  'session.error',
  'message.updated',
  'message.part.updated',
  'message.part.created',
  'permission.asked',
  'permission.updated',
  'permission.replied',
  'automations.updated',
  'assistant.updated',
  // The queue changes from the desktop and from its own draining, not just
  // from what the phone asked for. Without this a remote client only ever
  // sees the queue it returned from its own request.
  'thread.followups.updated'
])

export const DEFAULT_RELAY_URL = 'wss://boss-relay.fly.dev'

/** A pairing code is short-lived; an unused one must not stay valid. */
const PAIRING_TTL_MS = 5 * 60_000

/**
 * How many recent events the desktop keeps so a phone that slept can catch up.
 * A busy turn emits a few hundred small events, and a typical one measures
 * ~320 bytes, so 1000 costs roughly 0.3 MB — cheap enough to hold, deep enough
 * to cover a phone locking for a minute mid-turn. Beyond it the phone is told
 * there is a gap and refetches instead of showing a stream with holes in it.
 */
const EVENT_BUFFER_SIZE = 1000

interface RelayHost {
  handle(request: BackendRequest): Promise<unknown>
  onEvent(callback: (event: Record<string, unknown>) => void): () => void
}

interface RelayConfig {
  enabled: boolean
  relayUrl: string
  /**
   * Long-lived room secret. It derives the transport key, the device id, and
   * the join proof. Rotating it moves this desktop to a new room and so signs
   * out every phone at once.
   */
  secret: string
  /** Paired phones, each with a hash of its own token so one can be revoked alone. */
  devices: StoredDevice[]
  /**
   * Public keys that were forgotten. A forgotten phone still holds the room
   * secret and can still reach the room, so without this it could re-pair
   * itself the moment a code was next on screen. Keyed by key, which is why
   * the key had to become the identity.
   */
  blocked: string[]
}

/** Minimal shape of the `ws` client, so this module type-checks without the dependency present. */
interface Socket {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  on(event: string, listener: (...args: unknown[]) => void): void
  terminate(): void
}

type SocketFactory = (url: string) => Socket

export class RelayClient {
  private config: RelayConfig
  private socket: Socket | null = null
  private state: RemoteAccessStatus['state'] = 'off'
  private lastError?: string
  private attempt = 0
  private reconnectTimer?: NodeJS.Timeout
  private offEvents?: () => void
  private onChange?: () => void
  private key?: AesKey
  private deviceId?: string
  private readonly peerId = randomBytes(8).toString('base64url')
  /** Sequencing is monotonic per desktop run. A restart resets it, and the
   *  buffer reports a gap, so a phone refetches rather than trusting stale
   *  numbers. See event-buffer.ts for the replay rules. */
  private readonly events = new EventBuffer(EVENT_BUFFER_SIZE)
  private pairing?: { secret: string; code: string; expiresAt: number; timer: NodeJS.Timeout }
  /**
   * Who is in the room right now, as the relay reports it: peerId → public key.
   *
   * The claim frame carries no key — it is sealed with the pairing secret and
   * predates any of this — so the key a claiming phone proved to the relay is
   * learned here and correlated by peerId. Cleared on disconnect, because
   * presence is per-connection and must not outlive the socket.
   */
  private readonly present = new Map<string, string>()
  /** Keys seen in the room that never paired. Surfaced in settings only. */
  private readonly unknown = new Map<string, { firstSeenAt: number; lastSeenAt: number }>()
  /** Stopping must not trigger the reconnect loop. */
  private closing = false

  private readonly configFile: string
  private readonly host: RelayHost
  private readonly connect: SocketFactory
  /** This desktop's Ed25519 keypair. Owns the room; never leaves the machine. */
  private readonly identity: RelayIdentity

  // Plain fields rather than parameter properties: Node's type-stripping test
  // runner rejects the shorthand, and this class needs to be testable.
  constructor(configFile: string, host: RelayHost, connect: SocketFactory) {
    this.configFile = configFile
    this.host = host
    this.connect = connect
    // Beside the config, so a user who clears remote access clears both.
    this.identity = new RelayIdentity(configFile.replace(/\.json$/, '') + '-key.json')
    this.config = this.load()
  }

  setOnChange(callback: () => void): void {
    this.onChange = callback
  }

  private load(): RelayConfig {
    try {
      if (existsSync(this.configFile)) {
        const parsed = JSON.parse(readFileSync(this.configFile, 'utf8')) as Partial<RelayConfig>
        if (typeof parsed.secret === 'string' && parsed.secret.length >= 32) {
          return {
            enabled: Boolean(parsed.enabled),
            relayUrl: typeof parsed.relayUrl === 'string' && parsed.relayUrl ? parsed.relayUrl : DEFAULT_RELAY_URL,
            secret: parsed.secret,
            // Devices written before identity moved to the public key are
            // keyed by a random peerId, which no key will ever match. They
            // would sit in the list forever showing offline, and Revoke would
            // block a peerId that means nothing. Their pairings are dead
            // anyway — the keypair change moved the room — so drop them and
            // let the phone re-scan. A key is 43 base64url chars.
            devices: (Array.isArray(parsed.devices) ? parsed.devices : []).filter(
              (device) => looksLikeKey(device?.id)
            ),
            blocked: (Array.isArray(parsed.blocked) ? parsed.blocked : []).filter(looksLikeKey)
          }
        }
      }
    } catch {
      /* A damaged file falls through to a fresh secret below. */
    }
    return {
      enabled: false,
      relayUrl: DEFAULT_RELAY_URL,
      secret: randomBytes(32).toString('base64url'),
      devices: [],
      blocked: []
    }
  }

  private save(): void {
    try {
      writeFileSync(this.configFile, JSON.stringify(this.config, null, 2))
    } catch {
      /* Remote access keeps working in memory if persistence is unavailable. */
    }
  }

  status(): RemoteAccessStatus {
    return {
      enabled: this.config.enabled,
      relayUrl: this.config.relayUrl,
      state: this.state,
      error: this.lastError,
      pairing: this.pairing ? { code: this.pairing.code, expiresAt: this.pairing.expiresAt } : undefined,
      // tokenHash stays in the main process; the renderer has no use for it.
      devices: this.config.devices.map(({ tokenHash: _tokenHash, ...device }) => ({
        ...device,
        online: this.state === 'online' && device.online
      })),
      unknown: this.state === 'online'
        ? [...this.unknown.entries()].map(([id, seen]) => ({ id, ...seen }))
        : []
    }
  }

  async start(): Promise<void> {
    if (this.config.enabled) await this.openSocket()
  }

  async stop(): Promise<void> {
    this.closing = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.offEvents?.()
    this.offEvents = undefined
    this.socket?.close(1000, 'shutting down')
    this.socket = null
    this.state = 'off'
    this.closing = false
    this.onChange?.()
  }

  /**
   * Dial the relay. Every failure path schedules a retry, because the common
   * causes — no network, a sleeping laptop, a redeploying relay — all resolve
   * on their own.
   */
  private async openSocket(): Promise<void> {
    if (this.socket || this.closing) return
    this.state = 'connecting'
    this.lastError = undefined
    this.onChange?.()

    this.key = await deriveKey(crypto, this.config.secret)
    // The room now belongs to the keypair, not to the secret: it is the hash of
    // the public key, so only the holder of the private key can enter it.
    this.deviceId = await roomIdForKey(crypto, await this.identity.publicKey())

    let socket: Socket
    try {
      socket = this.connect(this.config.relayUrl)
    } catch (error) {
      this.fail(error)
      return
    }
    this.socket = socket

    // No hello here. The relay speaks first with a nonce and this desktop
    // answers with a signature over it, so a proof it captured is worthless on
    // any other connection. receive() sends the hello when the challenge lands.
    socket.on('open', () => {
      this.attempt = 0
    })

    socket.on('message', (raw: unknown) => void this.receive(String(raw)))

    socket.on('close', () => {
      this.socket = null
      this.offEvents?.()
      this.offEvents = undefined
      // Presence came from the relay over this socket. Without it we know
      // nothing, and a device left showing "connected" would be a lie.
      this.present.clear()
      this.unknown.clear()
      for (const device of this.config.devices) device.online = false
      if (this.closing || !this.config.enabled) {
        this.state = 'off'
        this.onChange?.()
        return
      }
      this.state = 'connecting'
      this.onChange?.()
      this.scheduleReconnect()
    })

    socket.on('error', (error: unknown) => {
      // 'close' always follows, so record the reason and let it reconnect.
      this.lastError = error instanceof Error ? error.message : String(error)
    })
  }

  private fail(error: unknown): void {
    this.state = 'error'
    this.lastError = error instanceof Error ? error.message : String(error)
    this.socket = null
    this.onChange?.()
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closing || !this.config.enabled) return
    const delay = reconnectDelay(this.attempt++)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      void this.openSocket()
    }, delay)
    // A pending reconnect must not hold the app open at quit time.
    this.reconnectTimer.unref?.()
  }

  /**
   * Record a phone the relay admitted to this room.
   *
   * A key we paired with is marked online. A key we have never paired with is
   * held as an unknown sighting: it can read nothing, because every payload is
   * sealed with a secret the relay never sees, but the user should be able to
   * see that it is there. Settings only — no notification, because the usual
   * cause is a stale reconnect from a phone that was forgotten.
   */
  private notePresence(publicKey: string, peerId: string): void {
    this.present.set(peerId, publicKey)
    const device = this.config.devices.find((d) => d.id === publicKey)
    if (device) {
      device.online = true
      device.lastSeenAt = Date.now()
      this.unknown.delete(publicKey)
    } else {
      const seen = this.unknown.get(publicKey)
      const now = Date.now()
      this.unknown.set(publicKey, { firstSeenAt: seen?.firstSeenAt ?? now, lastSeenAt: now })
    }
    this.onChange?.()
  }

  /** Answer the relay's challenge. The room id is derived locally from the
   *  public key, so both sides compute the same room without exchanging it. */
  private async greet(nonce: string): Promise<void> {
    const socket = this.socket
    if (!socket || socket.readyState !== 1) return
    try {
      const publicKey = await this.identity.publicKey()
      const deviceId = await roomIdForKey(crypto, publicKey)
      this.deviceId = deviceId
      socket.send(JSON.stringify({
        type: 'hello',
        side: 'desktop',
        peerId: this.peerId,
        publicKey,
        signature: await this.identity.sign(nonce, deviceId, 'desktop'),
        v: RELAY_PROTOCOL_VERSION
      }))
    } catch (error) {
      // Without a usable key this desktop can never join, so surface it rather
      // than reconnecting in a loop that cannot succeed.
      this.lastError = error instanceof Error ? error.message : String(error)
      this.onChange?.()
    }
  }

  private async receive(raw: string): Promise<void> {
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }
    // The relay opens with a nonce. Signing it proves this desktop owns the
    // room without ever sending anything reusable: the signature covers the
    // nonce, the room and the side, so it is good for this connection only.
    if (frame.type === 'challenge' && typeof frame.nonce === 'string') {
      await this.greet(frame.nonce)
      return
    }

    // Relay control frames carry no user content.
    if (typeof frame.type === 'string' && frame.type !== 'frame') {
      if (frame.type === 'error') this.lastError = String(frame.message ?? 'relay error')
      if (frame.type === 'phone.online' && typeof frame.publicKey === 'string' && typeof frame.peerId === 'string') {
        this.notePresence(frame.publicKey, frame.peerId)
        return
      }
      if (frame.type === 'phone.offline' && typeof frame.peerId === 'string') {
        this.present.delete(frame.peerId)
        const device = this.config.devices.find((d) => d.id === frame.publicKey)
        if (device) device.online = false
        this.onChange?.()
        return
      }
      if (frame.type === 'welcome') {
        // Online only once the relay has accepted the signature. Reporting it
        // at socket-open would show a working connection to a relay that was
        // about to refuse this desktop.
        this.state = 'online'
        this.lastError = undefined
        this.offEvents?.()
        this.offEvents = this.host.onEvent((event) => void this.broadcast(event))
      }
      this.onChange?.()
      return
    }
    if (typeof frame.sealed !== 'string' || !this.key) return
    const peerId = typeof frame.peerId === 'string' ? frame.peerId : ''

    let message = await open(crypto, this.key, frame.sealed)

    // A phone that has only scanned the QR code holds the one-time pairing
    // secret, not the room secret, so its claim is sealed with a different
    // key and the room key above cannot open it. Try the pairing key too,
    // but only while a code is live — otherwise pairing can never complete.
    if (!message && this.pairing && this.pairing.expiresAt >= Date.now()) {
      const pairingKey = await deriveKey(crypto, this.pairing.secret)
      message = await open(crypto, pairingKey, frame.sealed)
    }

    // A frame we cannot decrypt is not from a paired phone. Drop it silently:
    // an error reply would tell an unpaired prober that the room is live.
    if (!message) return

    if (message.kind === 'claim') {
      await this.completeClaim(peerId, message)
      return
    }
    if (message.kind === 'resume') {
      await this.resume(peerId, message)
      return
    }
    if (message.kind === 'request') {
      await this.serve(peerId, message)
    }
  }

  /**
   * A phone proves it holds the pairing code by sealing a claim with the key
   * derived from it. The phone then keeps the long-lived secret, so later
   * sessions reconnect without a new scan.
   */
  private async completeClaim(peerId: string, message: Extract<RelayMessage, { kind: 'claim' }>): Promise<void> {
    const pairing = this.pairing
    if (!pairing) {
      process.stderr.write('[relay] claim arrived but no pairing code is active\n')
      return
    }
    if (pairing.expiresAt < Date.now()) {
      process.stderr.write('[relay] claim arrived but the pairing code had expired\n')
      return
    }
    if (!sameSecret(message.secret, pairing.secret)) {
      process.stderr.write('[relay] claim arrived with a secret that does not match the shown code\n')
      return
    }

    // The key the claiming phone proved to the relay, learned from presence and
    // correlated by peerId. Identity must be the key, not the peerId: a phone
    // picks a fresh peerId at every pairing, so keying on it made one phone
    // appear as a new device each time and made Forget revoke a single pairing
    // rather than the phone.
    const publicKey = this.present.get(peerId)
    if (!publicKey) {
      process.stderr.write('[relay] claim arrived from a peer the relay never announced\n')
      return
    }
    if (this.config.blocked.includes(publicKey)) {
      process.stderr.write('[relay] claim refused: this device was forgotten\n')
      return
    }

    // Each phone gets its own token, so revoking one does not sign out the rest.
    const token = randomBytes(24).toString('base64url')
    const previous = this.config.devices.find((d) => d.id === publicKey)
    const device: StoredDevice = {
      id: publicKey,
      label: (message.label || 'Phone').slice(0, 40),
      // Re-pairing the same phone keeps its original pairing date: it is the
      // same device, not a new one.
      pairedAt: previous?.pairedAt ?? Date.now(),
      lastSeenAt: Date.now(),
      online: true,
      tokenHash: await hashToken(crypto, token)
    }
    this.unknown.delete(publicKey)
    this.config.devices = [...this.config.devices.filter((d) => d.id !== publicKey), device]
    this.save()
    // The phone still only holds the pairing secret, so this one reply must be
    // sealed with the pairing key. Everything after it uses the room key that
    // this message hands over. Send before clearing, or the key is gone.
    const pairingKey = await deriveKey(crypto, pairing.secret)
    await this.sendTo(peerId, { kind: 'claimed', secret: this.config.secret, token, role: 'control' }, pairingKey)
    // A pairing code is single-use: consuming it here stops a second scan.
    this.clearPairing()
    this.onChange?.()
  }

  /** The token must match a phone still on the paired list. */
  private async deviceFor(token: string): Promise<StoredDevice | null> {
    if (!token) return null
    const hash = await hashToken(crypto, token)
    return this.config.devices.find((device) => sameSecret(device.tokenHash, hash)) ?? null
  }

  /** Run one request locally, under the same allowlist the loopback server uses. */
  private async serve(peerId: string, message: Extract<RelayMessage, { kind: 'request' }>): Promise<void> {
    const request = message.request as BackendRequest
    const role: MobileAccessRole = 'control'
    try {
      const device = await this.deviceFor(message.token)
      // A revoked phone still holds the room key, so this check — not the
      // decryption — is what actually ends its access.
      if (!device) throw new Error('This device is no longer paired. Scan the QR code again.')
      device.lastSeenAt = Date.now()
      device.online = true
      if (!request || typeof request.type !== 'string') throw new Error('malformed request')
      if (!ALLOWED_REQUESTS.has(request.type) || !mobileRequestAllowed(request.type, role)) {
        throw new Error(`"${request.type}" is not available over remote access.`)
      }
      const result = await this.host.handle(request)
      if (await this.sendTo(peerId, { kind: 'response', id: message.id, ok: true, result: result ?? null })) return

      // Too large for one frame, so send it in several.
      //
      // This used to halve the list until it fit, which is why a Codex thread
      // arrived with only its last message or two: a transcript whose tool
      // output ran to megabytes was cut down by a factor of eight and the
      // result looked like missing history. Chunking sends all of it.
      if (await this.sendChunked(peerId, message.id, result ?? null)) return
      await this.sendTo(peerId, {
        kind: 'response',
        id: message.id,
        ok: false,
        error: 'This is too large to load over the relay. Open it on your desktop, or over Tailscale.'
      })
    } catch (error) {
      await this.sendTo(peerId, {
        kind: 'response',
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private async broadcast(event: Record<string, unknown>): Promise<void> {
    if (!FORWARDED_EVENTS.has(String(event.type ?? ''))) return
    // Number and retain before sending. A phone that is not connected right
    // now still gets this on its next resume, which is the whole point.
    const seq = this.events.push(event)
    await this.sendTo(undefined, { kind: 'event', event, seq })
  }

  /**
   * Answer a reconnecting phone. If the requested point has fallen out of the
   * buffer we say so rather than sending a partial stream: a visible refetch
   * beats a thread that is quietly missing messages.
   */
  private async resume(peerId: string, message: Extract<RelayMessage, { kind: 'resume' }>): Promise<void> {
    if (!(await this.deviceFor(message.token))) return
    const { events, gap, seq } = this.events.since(message.since)
    await this.sendTo(peerId, { kind: 'resumed', events, gap, seq })
  }

  /** `to` undefined fans out to every paired phone; that is how events flow. */
  /** `key` overrides the room key, which only the pairing reply needs. */
  /**
   * Seal and send one frame, or report that it was too large to send.
   *
   * The relay closes the whole socket on an oversized frame (1009), so a
   * single big thread did not merely fail to load — it dropped the connection
   * and every request in flight with it, then the phone reconnected and the
   * user saw a thread that never opened. Returns false so the caller can
   * answer with something the phone can render.
   */
  private async sendTo(to: string | undefined, message: RelayMessage, key?: AesKey): Promise<boolean> {
    const socket = this.socket
    const sealWith = key ?? this.key
    if (!socket || !sealWith || socket.readyState !== 1) return false
    const sealed = await seal(crypto, sealWith, message)
    const frame = JSON.stringify({ sealed, to })
    // Measure the encoded bytes, not the string length: the relay's cap is on
    // the wire payload, and multi-byte characters are common in transcripts.
    if (Buffer.byteLength(frame) > RELAY_MAX_FRAME_BYTES) return false
    socket.send(frame)
    return true
  }

  /**
   * Send one response as a sequence of chunks.
   *
   * The payload is serialized once and cut on byte boundaries, then each piece
   * is sealed and sent as its own frame — so the relay still sees only opaque
   * frames of a size it accepts. Chunks carry the request id, so a phone with
   * several requests in flight reassembles the right one.
   *
   * Returns false if any chunk fails to send, which leaves the caller to
   * answer with an error rather than the phone waiting on a stream that
   * stopped halfway.
   */
  private async sendChunked(peerId: string, id: string, result: unknown): Promise<boolean> {
    // Base64 before cutting. Slicing UTF-8 on a byte boundary splits multi-byte
    // characters, and a transcript is full of them — the pieces would decode to
    // replacement characters and the JSON would not parse. Base64 is
    // single-byte, so any cut is safe.
    const encoded = Buffer.from(JSON.stringify({ ok: true, result })).toString('base64')
    // Room for the chunk envelope, and for seal() growing what it is given by
    // a further third when it base64s the ciphertext.
    const slice = Math.floor((RELAY_MAX_FRAME_BYTES - 2_000) * 3 / 4)
    const total = Math.ceil(encoded.length / slice)
    if (total > MAX_RESPONSE_CHUNKS) return false

    for (let index = 0; index < total; index++) {
      const piece = encoded.slice(index * slice, (index + 1) * slice)
      if (!(await this.sendTo(peerId, { kind: 'chunk', id, index, total, body: piece }))) return false
    }
    return true
  }

  private clearPairing(): void {
    if (this.pairing) clearTimeout(this.pairing.timer)
    this.pairing = undefined
  }

  /**
   * Start pairing. The code carries the relay address and a one-time secret;
   * the long-lived secret is handed over only after the phone proves it holds
   * that code, so a photographed QR code alone expires in five minutes.
   */
  private async beginPairing(): Promise<RemoteAccessStatus> {
    this.clearPairing()
    const secret = randomBytes(18).toString('base64url')
    // The phone needs this desktop's room id to reach it at all, and cannot
    // derive it: the room is the hash of this desktop's public key. Publishing
    // the id is safe — entering the room needs the private key, which the QR
    // code does not carry and the phone never sees.
    const deviceId = this.deviceId ?? await roomIdForKey(crypto, await this.identity.publicKey())
    this.deviceId = deviceId
    const expiresAt = Date.now() + PAIRING_TTL_MS
    const timer = setTimeout(() => {
      this.pairing = undefined
      this.onChange?.()
    }, PAIRING_TTL_MS)
    timer.unref?.()
    this.pairing = {
      secret,
      expiresAt,
      timer,
      code: encodePairing({
        v: RELAY_PROTOCOL_VERSION,
        r: this.config.relayUrl,
        d: deviceId,
        s: secret
      })
    }
    return this.status()
  }

  async handle(request: BackendRequest): Promise<unknown> {
    switch (request.type) {
      case 'remote.status':
        return this.status()
      case 'remote.set': {
        const patch = request.patch
        if (patch.relayUrl !== undefined && patch.relayUrl.trim()) this.config.relayUrl = patch.relayUrl.trim()
        if (patch.enabled !== undefined) this.config.enabled = patch.enabled
        if (patch.forgetDeviceId) {
          // Block as well as remove. The phone still holds the room secret, so
          // deleting the row alone would let it re-pair on the next code.
          const id = patch.forgetDeviceId
          this.config.devices = this.config.devices.filter((d) => d.id !== id)
          if (!this.config.blocked.includes(id)) this.config.blocked = [...this.config.blocked, id]
          this.unknown.delete(id)
        }
        if (patch.revokeAll) {
          // Rotating the secret moves this desktop to a new room, which signs
          // out every phone at once.
          this.config.secret = randomBytes(32).toString('base64url')
          this.config.devices = []
          // A new room secret invalidates every old pairing anyway, so the
          // block list has nothing left to protect and would only grow.
          this.config.blocked = []
          this.unknown.clear()
        }
        this.save()
        const shouldRestart = patch.enabled !== undefined || patch.relayUrl !== undefined || patch.revokeAll
        if (shouldRestart) {
          await this.stop()
          if (this.config.enabled) await this.openSocket()
        }
        this.onChange?.()
        return this.status()
      }
      case 'remote.pair': {
        // beginPairing derives the room from the keypair, so pairing works
        // before the socket has ever connected.
        return await this.beginPairing()
      }
      case 'remote.pair.cancel': {
        this.clearPairing()
        this.onChange?.()
        return this.status()
      }
      default:
        throw new Error(`Unsupported remote request: ${request.type}`)
    }
  }
}
