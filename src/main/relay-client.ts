import { webcrypto, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { BackendRequest } from '../shared/backend'
import { mobileRequestAllowed, type MobileAccessRole } from '../shared/mobile'
import { EventBuffer } from '../shared/event-buffer'
import {
  deriveDeviceId,
  deriveJoinProof,
  deriveKey,
  encodePairing,
  hashToken,
  open,
  reconnectDelay,
  seal,
  RELAY_PROTOCOL_VERSION,
  type AesKey,
  type CryptoLike,
  type RelayMessage,
  type RemoteAccessStatus,
  type StoredDevice
} from '../shared/relay'

/**
 * Outbound half of remote access. The desktop dials the relay, so no inbound
 * port is opened and no firewall rule is needed.
 *
 * The trust boundary lives here, not on the relay. This process decrypts the
 * frame, applies the same allowlist the Tailscale path uses, and calls the
 * backend locally. Agent credentials never travel: the phone sends a request
 * name, and this machine performs it.
 */

const crypto = webcrypto as unknown as CryptoLike

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
  'thread.send',
  'thread.abort',
  'thread.todos',
  'thread.permission',
  'thread.diff',
  'automation.list',
  'automation.run',
  'automation.stop'
])

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
  'automations.updated'
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
  /** Stopping must not trigger the reconnect loop. */
  private closing = false

  private readonly configFile: string
  private readonly host: RelayHost
  private readonly connect: SocketFactory

  // Plain fields rather than parameter properties: Node's type-stripping test
  // runner rejects the shorthand, and this class needs to be testable.
  constructor(configFile: string, host: RelayHost, connect: SocketFactory) {
    this.configFile = configFile
    this.host = host
    this.connect = connect
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
            devices: Array.isArray(parsed.devices) ? parsed.devices : []
          }
        }
      }
    } catch {
      /* A damaged file falls through to a fresh secret below. */
    }
    return { enabled: false, relayUrl: DEFAULT_RELAY_URL, secret: randomBytes(32).toString('base64url'), devices: [] }
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
      }))
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
    this.deviceId = await deriveDeviceId(crypto, this.config.secret)
    const proof = await deriveJoinProof(crypto, this.config.secret)

    let socket: Socket
    try {
      socket = this.connect(this.config.relayUrl)
    } catch (error) {
      this.fail(error)
      return
    }
    this.socket = socket

    socket.on('open', () => {
      this.attempt = 0
      socket.send(JSON.stringify({
        type: 'hello',
        side: 'desktop',
        deviceId: this.deviceId,
        peerId: this.peerId,
        proof,
        v: RELAY_PROTOCOL_VERSION
      }))
      this.state = 'online'
      this.lastError = undefined
      this.offEvents?.()
      this.offEvents = this.host.onEvent((event) => void this.broadcast(event))
      this.onChange?.()
    })

    socket.on('message', (raw: unknown) => void this.receive(String(raw)))

    socket.on('close', () => {
      this.socket = null
      this.offEvents?.()
      this.offEvents = undefined
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

  private async receive(raw: string): Promise<void> {
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }
    // Relay control frames carry no user content.
    if (typeof frame.type === 'string' && frame.type !== 'frame') {
      if (frame.type === 'error') this.lastError = String(frame.message ?? 'relay error')
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

    // Each phone gets its own token, so revoking one does not sign out the rest.
    const token = randomBytes(24).toString('base64url')
    const device: StoredDevice = {
      id: peerId,
      label: (message.label || 'Phone').slice(0, 40),
      pairedAt: Date.now(),
      lastSeenAt: Date.now(),
      online: true,
      tokenHash: await hashToken(crypto, token)
    }
    this.config.devices = [...this.config.devices.filter((d) => d.id !== peerId), device]
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
      await this.sendTo(peerId, { kind: 'response', id: message.id, ok: true, result: result ?? null })
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
  private async sendTo(to: string | undefined, message: RelayMessage, key?: AesKey): Promise<void> {
    const socket = this.socket
    const sealWith = key ?? this.key
    if (!socket || !sealWith || socket.readyState !== 1) return
    const sealed = await seal(crypto, sealWith, message)
    socket.send(JSON.stringify({ sealed, to }))
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
    // The phone needs this desktop's room coordinates to reach it at all.
    const joinProof = await deriveJoinProof(crypto, this.config.secret)
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
        d: this.deviceId ?? '',
        s: secret,
        j: joinProof
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
          this.config.devices = this.config.devices.filter((d) => d.id !== patch.forgetDeviceId)
        }
        if (patch.revokeAll) {
          // Rotating the secret moves this desktop to a new room, which signs
          // out every phone at once.
          this.config.secret = randomBytes(32).toString('base64url')
          this.config.devices = []
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
        if (!this.deviceId) this.deviceId = await deriveDeviceId(crypto, this.config.secret)
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
