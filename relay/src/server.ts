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
import { MOBILE_PAGE } from '../../src/shared/mobile-page.js'
import { SERVICE_WORKER, WEB_MANIFEST } from '../../src/shared/pwa-assets.js'

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

wss.on('connection', (socket) => {
  socket.on('message', (raw) => {
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(String(raw)) as Record<string, unknown>
    } catch {
      send(socket, { type: 'error', message: 'malformed frame' })
      return
    }

    const state = attached.get(socket)

    // The first frame must be a hello that claims a device id and a side.
    if (!state) {
      const deviceId = typeof frame.deviceId === 'string' ? frame.deviceId : ''
      const peerId = typeof frame.peerId === 'string' ? frame.peerId : ''
      const proof = typeof frame.proof === 'string' ? frame.proof : ''
      const side = frame.side === 'desktop' ? 'desktop' : frame.side === 'phone' ? 'phone' : null
      if (frame.type !== 'hello' || !side || !isId(deviceId) || !isId(peerId) || !isId(proof)) {
        send(socket, { type: 'error', message: 'expected hello' })
        socket.close(1008, 'expected hello')
        return
      }
      const result = rooms.join(deviceId, proof, { peerId, side, socket })
      if (result.rejected) {
        send(socket, { type: 'error', message: result.rejected })
        socket.close(1008, result.rejected)
        return
      }
      if (result.displaced) {
        send(result.displaced.socket, { type: 'error', message: 'replaced by a newer desktop connection' })
        result.displaced.socket.close(1000, 'replaced')
      }
      attached.set(socket, { deviceId, peerId, side, alive: true })
      send(socket, {
        type: 'welcome',
        deviceId,
        peerId,
        desktopOnline: rooms.desktopOnline(deviceId)
      })
      if (side === 'desktop') notifyDesktopPresence(deviceId)
      else send(socket, { type: rooms.desktopOnline(deviceId) ? 'peer.online' : 'peer.offline', desktopOnline: rooms.desktopOnline(deviceId) })
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

/** Device and peer ids are opaque base64url strings; bound them so a room key cannot be abused. */
function isId(value: string): boolean {
  return value.length > 0 && value.length <= 64 && /^[A-Za-z0-9_-]+$/.test(value)
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
