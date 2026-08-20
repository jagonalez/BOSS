/**
 * BOSS relay. A stateless WebSocket pipe between a desktop and its phones.
 *
 * What this process CAN see: device ids, connection times, frame sizes, and
 * source IP addresses. What it CANNOT see: chat content, agent credentials,
 * backend tokens, or the pairing secret — every payload arrives already
 * sealed with a key derived on the two endpoints.
 *
 * Nothing is written to disk and nothing survives a restart. A restart just
 * makes both sides reconnect.
 */
import { createServer } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { Rooms } from './rooms.js'
// Copied in from src/shared by `npm run sync`, which build and test both run.
// Importing across trees made tsc's rootDir span two roots, and the emitted
// layout then differed between a local build and the container — the deploy
// started and died on a module that resolved but exported nothing.
import { MOBILE_PAGE } from './shared/mobile-page.js'
import { SERVICE_WORKER, WEB_MANIFEST } from './shared/pwa-assets.js'
import {
  challengeExpired,
  challengeMessage,
  looksLikeKey,
  looksLikeSignature,
  newNonce,
  roomIdForKey,
  verifySignature,
  type Challenge,
  type SigningCrypto
} from './shared/identity.js'
import { webcrypto } from 'node:crypto'

const crypto = webcrypto as unknown as SigningCrypto

const PORT = Number(process.env.PORT ?? 8080)
/** fly.io routes to the machine's internal address; override to bind narrowly. */
const HOST = process.env.HOST ?? '0.0.0.0'
const MAX_FRAME_BYTES = 512_000
/** A socket that misses two heartbeats is gone; the phone reconnects. */
const HEARTBEAT_MS = 30_000

const rooms = new Rooms<WebSocket>()

const http = createServer((request, response) => {
  const path = (request.url ?? '/').split('?')[0]
  if (path === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true, rooms: rooms.size }))
    return
  }
  // The relay also serves the phone page, so a phone can reach BOSS from a
  // cell network without loading anything off the user's machine. The page is
  // static and identical for everyone; the pairing secret arrives in the URL
  // fragment, which browsers never send to a server.
  if (path === '/' && request.method === 'GET') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(MOBILE_PAGE)
    return
  }
  if (path === '/manifest.webmanifest' && request.method === 'GET') {
    response.writeHead(200, { 'content-type': 'application/manifest+json' }).end(WEB_MANIFEST)
    return
  }
  if (path === '/sw.js' && request.method === 'GET') {
    response.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-cache' }).end(SERVICE_WORKER)
    return
  }
  response.writeHead(404).end()
})

const wss = new WebSocketServer({ server: http, maxPayload: MAX_FRAME_BYTES })

interface Attached {
  deviceId: string
  peerId: string
  side: 'desktop' | 'phone'
  alive: boolean
}

const attached = new WeakMap<WebSocket, Attached>()

function send(socket: WebSocket, value: unknown): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(value))
}

function notifyDesktopPresence(deviceId: string): void {
  const online = rooms.desktopOnline(deviceId)
  for (const phone of rooms.phonesOf(deviceId)) {
    send(phone.socket, { type: online ? 'peer.online' : 'peer.offline', desktopOnline: online })
  }
}

wss.on('connection', (socket, request) => {
  // A socket that never opens on the client looks identical to one that never
  // arrives. Logging the attempt tells those apart.
  process.stdout.write(`[relay] socket opened from ${request.socket.remoteAddress}\n`)

  // The relay speaks first. A peer cannot choose what it signs, so a signature
  // captured here is worthless on any other connection.
  const challenge = { nonce: newNonce(crypto), issuedAt: Date.now() }
  send(socket, { type: 'challenge', nonce: challenge.nonce })

  socket.on('message', (raw) => {
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(String(raw)) as Record<string, unknown>
    } catch {
      send(socket, { type: 'error', message: 'malformed frame' })
      return
    }

    const state = attached.get(socket)

    // The first frame must be a hello proving the peer holds a private key.
    if (!state) {
      void admit(socket, frame, challenge)
      return
    }

    if (frame.type === 'ping') {
      send(socket, { type: 'pong' })
      return
    }

    // Everything else is opaque. The relay checks only that a sealed payload
    // is present, then forwards it. It cannot and does not inspect content.
    if (typeof frame.sealed !== 'string' || !frame.sealed) {
      send(socket, { type: 'error', message: 'frame is not sealed' })
      return
    }

    const to = typeof frame.to === 'string' ? frame.to : undefined
    // A sender cannot forge its identity: the relay stamps the frame with the
    // ids it recorded at hello time and ignores whatever the payload claimed.
    const outgoing = {
      deviceId: state.deviceId,
      from: state.side,
      peerId: state.peerId,
      sealed: frame.sealed
    }
    const targets = rooms.route(state.deviceId, state.side, state.side === 'desktop' ? to : undefined)
    for (const target of targets) send(target.socket, outgoing)
    if (targets.length === 0 && state.side === 'phone') {
      send(socket, { type: 'peer.offline', desktopOnline: false })
    }
  })

  socket.on('pong', () => {
    const state = attached.get(socket)
    if (state) state.alive = true
  })

  socket.on('close', () => {
    const state = attached.get(socket)
    if (!state) return
    rooms.leave(state.deviceId, state.peerId)
    attached.delete(socket)
    if (state.side === 'desktop') notifyDesktopPresence(state.deviceId)
  })

  socket.on('error', () => {
    /* 'close' does the cleanup; an error alone is not actionable here. */
  })
})

/** Peer ids are opaque base64url strings chosen by the client; bound them. */
function isId(value: string): boolean {
  return value.length > 0 && value.length <= 64 && /^[A-Za-z0-9_-]+$/.test(value)
}

/**
 * Admit a socket, or refuse it.
 *
 * A DESKTOP's room is derived from the key that signed the nonce, never taken
 * from the frame, so it can only ever own the one room its key hashes to. That
 * is what makes a room unclaimable: knowing an id is not knowing a key.
 *
 * A PHONE names the room it wants, because it cannot compute the desktop's —
 * the QR code hands it the id. The signature covers that id, so the relay
 * still learns which phone is asking and cannot be told a lie about it. What
 * the relay deliberately does NOT decide is whether that phone belongs there:
 * it holds no list of paired devices and could not check one without being
 * given something worth stealing. The desktop is the only party that knows,
 * and it enforces it by key — a phone it has not paired cannot open a single
 * frame, because every payload is sealed with a secret the relay never sees.
 * So the worst an unpaired phone achieves here is to sit in a room reading
 * ciphertext it cannot decrypt.
 */
async function admit(socket: WebSocket, frame: Record<string, unknown>, challenge: Challenge): Promise<void> {
  const refuse = (message: string): void => {
    send(socket, { type: 'error', message })
    socket.close(1008, message)
  }

  const publicKey = frame.publicKey
  const signature = frame.signature
  const peerId = typeof frame.peerId === 'string' ? frame.peerId : ''
  const side = frame.side === 'desktop' ? 'desktop' : frame.side === 'phone' ? 'phone' : null

  if (frame.type !== 'hello' || !side || !isId(peerId)) return refuse('expected hello')
  if (!looksLikeKey(publicKey) || !looksLikeSignature(signature)) return refuse('expected a signed hello')
  // A slow phone gets 30 seconds; beyond that the nonce is worthless anyway.
  if (challengeExpired(challenge, Date.now())) return refuse('challenge expired, reconnect')

  // A phone asks for a room; a desktop's is dictated by its key.
  const asked = typeof frame.deviceId === 'string' ? frame.deviceId : ''
  if (side === 'phone' && !isId(asked)) return refuse('a phone must name the room it is joining')
  const deviceId = side === 'desktop' ? await roomIdForKey(crypto, publicKey) : asked

  const proven = await verifySignature(
    crypto,
    publicKey,
    signature,
    challengeMessage(challenge.nonce, deviceId, side)
  )
  if (!proven) return refuse('signature did not verify')

  // The socket may have gone while the signature was being checked.
  if (socket.readyState !== socket.OPEN) return

  const result = rooms.join(deviceId, { peerId, side, socket })
  if (result.rejected) return refuse(result.rejected)
  if (result.displaced) {
    send(result.displaced.socket, { type: 'error', message: 'replaced by a newer desktop connection' })
    result.displaced.socket.close(1000, 'replaced')
  }

  attached.set(socket, { deviceId, peerId, side, alive: true })
  process.stdout.write(`[relay] ${side} joined room ${deviceId.slice(0, 8)}… as ${peerId}\n`)
  send(socket, { type: 'welcome', deviceId, peerId, desktopOnline: rooms.desktopOnline(deviceId) })
  if (side === 'desktop') notifyDesktopPresence(deviceId)
  else send(socket, {
    type: rooms.desktopOnline(deviceId) ? 'peer.online' : 'peer.offline',
    desktopOnline: rooms.desktopOnline(deviceId)
  })
}

const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    const state = attached.get(socket)
    if (state && !state.alive) {
      socket.terminate()
      continue
    }
    if (state) state.alive = false
    socket.ping()
  }
}, HEARTBEAT_MS)

wss.on('close', () => clearInterval(heartbeat))

http.listen(PORT, HOST, () => {
  process.stdout.write(`[relay] listening on ${HOST}:${PORT}\n`)
})
