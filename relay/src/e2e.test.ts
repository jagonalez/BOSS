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
import { deriveDeviceId, deriveJoinProof, deriveKey, open, seal } from '../../src/shared/relay.ts'

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
    const timer = setTimeout(() => reject(new Error('timed out waiting for a frame')), 5000)
    const onMessage = (raw: unknown): void => {
      const frame = JSON.parse(String(raw)) as Record<string, unknown>
      if (!match(frame)) return
      clearTimeout(timer)
      socket.off('message', onMessage)
      resolve(frame)
    }
    socket.on('message', onMessage)
  })
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
  relay = spawn('node', ['dist/relay/src/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: 'ignore'
  })
  // Wait for the listener rather than guessing at a fixed delay.
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
  const deviceId = await deriveDeviceId(crypto, secret)
  const proof = await deriveJoinProof(crypto, secret)
  const key = await deriveKey(crypto, secret)

  const desktop = await connect()
  desktop.send(JSON.stringify({ type: 'hello', side: 'desktop', deviceId, peerId: 'desk1', proof }))
  await next(desktop, (f) => f.type === 'welcome')

  const phone = await connect()
  phone.send(JSON.stringify({ type: 'hello', side: 'phone', deviceId, peerId: 'phone1', proof }))
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
  const deviceId = await deriveDeviceId(crypto, secret)
  const proof = await deriveJoinProof(crypto, secret)
  const key = await deriveKey(crypto, secret)
  const attackerKey = await deriveKey(crypto, 'a-guessed-secret')

  const desktop = await connect()
  desktop.send(JSON.stringify({ type: 'hello', side: 'desktop', deviceId, peerId: 'desk2', proof }))
  await next(desktop, (f) => f.type === 'welcome')

  const phone = await connect()
  phone.send(JSON.stringify({ type: 'hello', side: 'phone', deviceId, peerId: 'phone2', proof }))
  await next(phone, (f) => f.type === 'welcome')

  phone.send(JSON.stringify({ sealed: await seal(crypto, key, { kind: 'ping' }) }))
  const frame = await next(desktop, (f) => typeof f.sealed === 'string')
  // This is exactly what a compromised relay host would hold.
  assert.equal(await open(crypto, attackerKey, String(frame.sealed)), null)

  desktop.close()
  phone.close()
})

liveTest('a wrong join proof is refused by the live relay', async () => {
  const secret = 'another-pairing-secret'
  const deviceId = await deriveDeviceId(crypto, secret)
  const proof = await deriveJoinProof(crypto, secret)

  const desktop = await connect()
  desktop.send(JSON.stringify({ type: 'hello', side: 'desktop', deviceId, peerId: 'desk3', proof }))
  await next(desktop, (f) => f.type === 'welcome')

  // Someone who learned the device id but not the secret.
  const intruder = await connect()
  const closed = new Promise<number>((resolve) => intruder.once('close', (code) => resolve(code)))
  intruder.send(JSON.stringify({ type: 'hello', side: 'desktop', deviceId, peerId: 'evil', proof: 'wrongproof' }))
  assert.equal(await closed, 1008, 'the relay should reject a bad proof')

  desktop.close()
})
