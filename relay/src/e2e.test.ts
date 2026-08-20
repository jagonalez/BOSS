/**
 * End-to-end check against a live relay process: a desktop and a phone both
 * dial in, exchange sealed frames, and the relay proves it cannot read them.
 *
 * This is the test that would catch a framing or handshake mistake that the
 * pure routing tests cannot see.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { webcrypto } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { WebSocket } from 'ws'
import { deriveKey, open, seal } from '../../src/shared/relay.ts'
import { challengeMessage, roomIdFor, toBase64Url } from '../../src/shared/identity.ts'

const crypto = webcrypto as never
const PORT = 8899
const RELAY_URL = `ws://127.0.0.1:${PORT}`

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(RELAY_URL)
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

/** Resolve with the next frame matching `match`, so unrelated presence frames do not race. */
function next(socket: WebSocket, match: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const seen: string[] = []
    // Report what DID arrive. A bare timeout cannot tell a silent relay from
    // one that refused the handshake, and that cost real time here.
    const timer = setTimeout(() => reject(new Error('timed out waiting for a frame; saw: ' + JSON.stringify(seen))), 5000)
    const onMessage = (raw: unknown): void => {
      const frame = JSON.parse(String(raw)) as Record<string, unknown>
      seen.push(String(frame.type ?? 'sealed') + (frame.message ? ':' + String(frame.message) : ''))
      if (!match(frame)) return
      clearTimeout(timer)
      socket.off('message', onMessage)
      resolve(frame)
    }
    socket.on('message', onMessage)
  })
}

interface Identity {
  publicKey: string
  roomId: string
  sign(nonce: string, roomId: string, side: 'desktop' | 'phone'): Promise<string>
}

// The generate/sign half of WebCrypto, which SigningCrypto deliberately omits:
// the relay only ever verifies. Declared here so the test can act as a peer.
const signing = webcrypto as unknown as {
  subtle: {
    generateKey(a: { name: string }, e: boolean, u: string[]): Promise<{ publicKey: object; privateKey: object }>
    exportKey(format: 'raw', key: object): Promise<ArrayBuffer>
    digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>
    sign(a: { name: string }, key: object, data: Uint8Array): Promise<ArrayBuffer>
  }
}

/** A peer with its own Ed25519 keypair, exactly as a real desktop or phone has. */
async function identity(): Promise<Identity> {
  const pair = await signing.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const raw = new Uint8Array(await signing.subtle.exportKey('raw', pair.publicKey))
  return {
    publicKey: toBase64Url(raw),
    roomId: roomIdFor(await signing.subtle.digest('SHA-256', raw)),
    sign: async (nonce, roomId, side) => toBase64Url(new Uint8Array(
      await signing.subtle.sign({ name: 'Ed25519' }, pair.privateKey, challengeMessage(nonce, roomId, side))
    ))
  }
}

/**
 * Dial in and answer the relay's challenge. `room` defaults to the peer's own,
 * and is overridable so a test can try to sign its way into someone else's.
 */
async function join(
  who: Identity,
  side: 'desktop' | 'phone',
  peerId: string,
  room?: string
): Promise<WebSocket> {
  const socket = await connect()
  const challenge = await next(socket, (f) => f.type === 'challenge')
  const target = room ?? who.roomId
  socket.send(JSON.stringify({
    type: 'hello',
    side,
    // A desktop's room comes from its key and this is ignored; a phone must
    // name the room the QR code gave it.
    deviceId: target,
    peerId,
    publicKey: who.publicKey,
    signature: await who.sign(String(challenge.nonce), target, side)
  }))
  return socket
}

let relay: ChildProcess | null = null

/**
 * Some sandboxes forbid listening on a socket at all. That is an environment
 * limit, not a defect, so these tests skip rather than report a false failure.
 */
async function canListen(): Promise<boolean> {
  const { createServer } = await import('node:http')
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.listen(0, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

const listenable = await canListen()

test.before(async () => {
  if (!listenable) return
  // Run the compiled server, which is exactly what the Docker image starts.
  // Requires `npm run build` first; `npm test` in this package does that.
  // dist/server.js, not dist/relay/src/server.js: tsconfig's rootDir is "src",
  // so the output is flat. The old nested path kept working only because a
  // stale build sat there, and the tests silently ran a months-old relay.
  relay = spawn('node', ['dist/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: 'ignore'
  })
  // Wait for the listener rather than guessing at a fixed delay.
  // A relay left running by an earlier run would answer instead of the one
  // just built, and the suite would silently test stale code. That is exactly
  // how a months-old binary kept passing here. Refuse the port unless it is
  // ours.
  relay.once('exit', (code) => {
    if (code !== 0 && code !== null) {
      throw new Error(`the relay exited with ${code} — another process may hold port ${PORT}`)
    }
  })
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const probe = await connect()
      probe.close()
      return
    } catch {
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  throw new Error('relay did not start')
})

test.after(() => {
  relay?.kill()
})

const liveTest = listenable
  ? test
  : (name: string) => test.skip(`${name} (sandbox forbids listening)`, () => {})

liveTest('a phone and a desktop exchange sealed frames through the relay', async () => {
  const secret = 'shared-pairing-secret-for-the-test'
  const key = await deriveKey(crypto, secret)
  const owner = await identity()
  // The phone signs with its OWN key but joins the desktop's room, which is
  // what the QR code hands it.
  const handset = await identity()

  const desktop = await join(owner, 'desktop', 'desk1')
  await next(desktop, (f) => f.type === 'welcome')

  const phone = await join(handset, 'phone', 'phone1', owner.roomId)
  const welcome = await next(phone, (f) => f.type === 'welcome')
  assert.equal(welcome.desktopOnline, true, 'the phone should see its desktop online')

  // Phone → desktop request.
  phone.send(JSON.stringify({ sealed: await seal(crypto, key, { kind: 'request', id: '7', request: { type: 'thread.list' }, token: 'tok' }) }))
  const relayed = await next(desktop, (f) => typeof f.sealed === 'string')
  assert.equal(relayed.from, 'phone')
  assert.equal(relayed.peerId, 'phone1')

  // The relay forwarded ciphertext, not content.
  assert.doesNotMatch(String(relayed.sealed), /thread\.list/)
  assert.deepEqual(await open(crypto, key, String(relayed.sealed)), {
    kind: 'request', id: '7', request: { type: 'thread.list' }, token: 'tok'
  })

  // Desktop → phone response, addressed to the sender.
  desktop.send(JSON.stringify({
    to: 'phone1',
    sealed: await seal(crypto, key, { kind: 'response', id: '7', ok: true, result: [{ id: 'thread-1' }] })
  }))
  const answer = await next(phone, (f) => typeof f.sealed === 'string')
  const decoded = await open(crypto, key, String(answer.sealed))
  assert.deepEqual(decoded, { kind: 'response', id: '7', ok: true, result: [{ id: 'thread-1' }] })

  desktop.close()
  phone.close()
})

liveTest('a peer holding a different secret cannot read the traffic', async () => {
  const secret = 'the-real-pairing-secret'
  const key = await deriveKey(crypto, secret)
  const attackerKey = await deriveKey(crypto, 'a-guessed-secret')
  const owner = await identity()
  const handset = await identity()

  const desktop = await join(owner, 'desktop', 'desk2')
  await next(desktop, (f) => f.type === 'welcome')

  const phone = await join(handset, 'phone', 'phone2', owner.roomId)
  await next(phone, (f) => f.type === 'welcome')

  phone.send(JSON.stringify({ sealed: await seal(crypto, key, { kind: 'ping' }) }))
  const frame = await next(desktop, (f) => typeof f.sealed === 'string')
  // This is exactly what a compromised relay host would hold.
  assert.equal(await open(crypto, attackerKey, String(frame.sealed)), null)

  desktop.close()
  phone.close()
})

liveTest('knowing a room id is not enough to enter it', async () => {
  // The attack the old static proof allowed. A room id travels in every QR
  // code and past the relay host on every connection, so it must not be a
  // credential. Here the intruder knows the id and still cannot get in.
  const owner = await identity()
  const intruder = await identity()

  const desktop = await join(owner, 'desktop', 'desk3')
  await next(desktop, (f) => f.type === 'welcome')

  const socket = await join(intruder, 'desktop', 'evil', owner.roomId)
  const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)))
  assert.equal(await closed, 1008, 'a signature by the wrong key must be refused')

  // And the real desktop still holds the room.
  const phone = await identity()
  const check = await join(phone, 'phone', 'phone3', owner.roomId)
  const welcome = await next(check, (f) => f.type === 'welcome')
  assert.equal(welcome.desktopOnline, true, 'the intruder must not have displaced the desktop')

  desktop.close()
  check.close()
})

liveTest('a signature captured from one connection is refused on the next', async () => {
  // What a compromised relay host actually holds: every nonce it issued and
  // every signature it received. Replaying one must get it nowhere.
  const owner = await identity()

  const first = await connect()
  const challenge = await next(first, (f) => f.type === 'challenge')
  const captured = await owner.sign(String(challenge.nonce), owner.roomId, 'desktop')
  first.send(JSON.stringify({ type: 'hello', side: 'desktop', peerId: 'desk4', publicKey: owner.publicKey, signature: captured }))
  await next(first, (f) => f.type === 'welcome')

  // A second connection gets a different nonce, so the old signature is dead.
  const replay = await connect()
  await next(replay, (f) => f.type === 'challenge')
  const closed = new Promise<number>((resolve) => replay.once('close', (code) => resolve(code)))
  replay.send(JSON.stringify({ type: 'hello', side: 'desktop', peerId: 'evil2', publicKey: owner.publicKey, signature: captured }))
  assert.equal(await closed, 1008, 'a replayed signature must be refused')

  first.close()
})

liveTest('the room a peer lands in comes from its key, not from what it asks for', async () => {
  // A peer sends no room id at all. Two peers signing for the same room with
  // different keys must end up in different rooms, never in each other's.
  const one = await identity()
  const two = await identity()
  assert.notEqual(one.roomId, two.roomId)

  const deskOne = await join(one, 'desktop', 'a1')
  const welcomeOne = await next(deskOne, (f) => f.type === 'welcome')
  const deskTwo = await join(two, 'desktop', 'b1')
  const welcomeTwo = await next(deskTwo, (f) => f.type === 'welcome')

  assert.equal(welcomeOne.deviceId, one.roomId)
  assert.equal(welcomeTwo.deviceId, two.roomId)

  // A phone in room one must not reach the desktop in room two.
  const phone = await identity()
  const inOne = await join(phone, 'phone', 'p1', one.roomId)
  await next(inOne, (f) => f.type === 'welcome')
  const key = await deriveKey(crypto, 'room-one-secret')
  inOne.send(JSON.stringify({ sealed: await seal(crypto, key, { kind: 'ping' }) }))

  const heard = await Promise.race([
    next(deskOne, (f) => typeof f.sealed === 'string').then(() => 'one'),
    next(deskTwo, (f) => typeof f.sealed === 'string').then(() => 'two'),
    new Promise((r) => setTimeout(() => r('nobody'), 1000))
  ])
  assert.equal(heard, 'one', 'the frame must reach only the desktop of that room')

  deskOne.close()
  deskTwo.close()
  inOne.close()
})
