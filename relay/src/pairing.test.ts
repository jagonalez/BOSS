/**
 * The test that should have existed before any of this shipped: a real
 * RelayClient, a real relay process, and a phone doing the real QR handshake.
 *
 * Three separate bugs made pairing impossible in the first version, and every
 * one of them was invisible to a unit test because each side was correct in
 * isolation:
 *
 *   1. the phone derived its room id from the PAIRING secret, so it joined a
 *      room the desktop was not in and the claim reached nobody;
 *   2. the desktop only tried the ROOM key, so it could not open a claim
 *      sealed with the pairing key;
 *   3. the desktop sealed its reply with the ROOM key, which the phone does
 *      not have until that very reply delivers it.
 *
 * Anything that reintroduces one of those fails here.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { webcrypto } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { RelayClient } from '../dist/test/relay-client.mjs'
import { decodePairing, deriveKey, open, seal } from '../../src/shared/relay.ts'
import { challengeMessage, toBase64Url } from '../../src/shared/identity.ts'

const crypto = webcrypto as never
// The generate/sign half of WebCrypto, so the test can act as a real phone.
const signing = webcrypto as unknown as {
  subtle: {
    generateKey(a: { name: string }, e: boolean, u: string[]): Promise<{ publicKey: object; privateKey: object }>
    exportKey(format: 'raw', key: object): Promise<ArrayBuffer>
    sign(a: { name: string }, key: object, data: Uint8Array): Promise<ArrayBuffer>
  }
}
const PORT = 8902

async function canListen(): Promise<boolean> {
  const { createServer } = await import('node:http')
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.listen(0, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

const listenable = await canListen()
const liveTest = listenable
  ? test
  : (name: string) => test.skip(`${name} (sandbox forbids listening)`, () => {})

let relay: ChildProcess | null = null
let dir = ''

test.before(async () => {
  if (!listenable) return
  dir = await mkdtemp(join(tmpdir(), 'boss-pairing-'))
  relay = spawn('node', ['dist/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: 'ignore'
  })
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
      const probe = new WebSocket(`ws://127.0.0.1:${PORT}`)
      await new Promise<void>((resolve, reject) => {
        probe.once('open', () => { probe.close(); resolve() })
        probe.once('error', reject)
      })
      return
    } catch {
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  throw new Error('relay did not start')
})

test.after(async () => {
  relay?.kill()
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
})


/**
 * A phone with its own keypair, doing the real QR handshake: answer the
 * relay's challenge, then claim with the pairing secret.
 *
 * `keys` is passed back in to re-pair the SAME phone, which is the case that
 * proves identity is the key and not the peerId.
 */
async function pairPhone(
  payload: { r: string; d: string; s: string },
  peerId: string,
  keys?: { publicKey: object; privateKey: object }
): Promise<{ reply: Record<string, unknown> | null; keys: { publicKey: object; privateKey: object }; socket: WebSocket }> {
  const pair = keys ?? await signing.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const publicKey = new Uint8Array(await signing.subtle.exportKey('raw', pair.publicKey))
  const pairingKey = await deriveKey(crypto, payload.s)
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}`)

  const reply = new Promise<Record<string, unknown> | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 6000)
    socket.on('message', async (raw: unknown) => {
      const frame = JSON.parse(String(raw)) as Record<string, unknown>
      if (frame.type === 'challenge') {
        const signature = new Uint8Array(await signing.subtle.sign(
          { name: 'Ed25519' }, pair.privateKey,
          challengeMessage(String(frame.nonce), payload.d, 'phone')
        ))
        socket.send(JSON.stringify({
          type: 'hello', side: 'phone', deviceId: payload.d, peerId,
          publicKey: toBase64Url(publicKey), signature: toBase64Url(signature), v: 1
        }))
        return
      }
      if (frame.type === 'welcome') {
        socket.send(JSON.stringify({
          sealed: await seal(crypto, pairingKey, { kind: 'claim', secret: payload.s, label: 'TestPhone' })
        }))
        return
      }
      if (typeof frame.sealed !== 'string') return
      const message = await open(crypto, pairingKey, frame.sealed)
      if (message?.kind === 'claimed') {
        clearTimeout(timer)
        resolve(message as unknown as Record<string, unknown>)
      }
    })
  })

  return { reply: await reply, keys: pair, socket }
}

liveTest('a phone pairs with a desktop by scanning its QR code', async () => {
  const desktop = new RelayClient(
    join(dir, 'remote-access.json'),
    { handle: async () => [], onEvent: () => () => {} },
    (url: string) => new WebSocket(url) as never
  )

  await desktop.handle({ type: 'remote.set', patch: { enabled: true, relayUrl: `ws://127.0.0.1:${PORT}` } })
  // Give the outbound socket a moment to reach the relay.
  for (let i = 0; i < 40 && desktop.status().state !== 'online'; i += 1) {
    await new Promise((r) => setTimeout(r, 50))
  }
  assert.equal(desktop.status().state, 'online', 'the desktop must reach the relay first')

  const status = await desktop.handle({ type: 'remote.pair' })
  const payload = decodePairing((status as { pairing: { code: string } }).pairing.code)
  assert.ok(payload, 'the QR code must decode')
  // The room id is the only routing fact the phone cannot compute: it is the
  // hash of the desktop's public key. It is safe to publish, because entering
  // the room needs the private key the QR code never carries.
  assert.ok(payload.d, 'the code must carry the desktop room id')

  // --- the phone, using ONLY what the QR code gave it ---
  const pairingKey = await deriveKey(crypto, payload.s)
  const phone = new WebSocket(`ws://127.0.0.1:${PORT}`)
  const claimed = new Promise<Record<string, unknown> | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 6000)
    phone.on('message', async (raw: unknown) => {
      const frame = JSON.parse(String(raw)) as Record<string, unknown>
      if (typeof frame.sealed !== 'string') return
      const message = await open(crypto, pairingKey, frame.sealed)
      if (message?.kind === 'claimed') {
        clearTimeout(timer)
        resolve(message as unknown as Record<string, unknown>)
      }
    })
  })

  // The phone mints its own keypair and answers the relay's challenge with it.
  // It proves which phone is asking; the desktop decides whether to let it in.
  const pair = await signing.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const publicKey = new Uint8Array(await signing.subtle.exportKey('raw', pair.publicKey))

  const admitted = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the relay never admitted the phone')), 6000)
    phone.on('message', async (raw: unknown) => {
      const frame = JSON.parse(String(raw)) as Record<string, unknown>
      if (frame.type === 'challenge') {
        const signature = new Uint8Array(await signing.subtle.sign(
          { name: 'Ed25519' }, pair.privateKey,
          challengeMessage(String(frame.nonce), payload.d, 'phone')
        ))
        phone.send(JSON.stringify({
          type: 'hello', side: 'phone', deviceId: payload.d, peerId: 'test-phone',
          publicKey: toBase64Url(publicKey), signature: toBase64Url(signature), v: 1
        }))
      }
      if (frame.type === 'welcome') { clearTimeout(timer); resolve() }
    })
  })
  await admitted
  phone.send(JSON.stringify({
    sealed: await seal(crypto, pairingKey, { kind: 'claim', secret: payload.s, label: 'TestPhone' })
  }))

  const reply = await claimed
  assert.ok(reply, 'the desktop must answer a valid claim')
  assert.equal(reply.role, 'control')
  assert.ok(typeof reply.token === 'string' && reply.token.length > 0, 'the phone gets its own token')
  assert.ok(typeof reply.secret === 'string', 'the phone receives the room secret')
  assert.notEqual(reply.secret, payload.s, 'the room secret must differ from the one-time pairing secret')

  // The desktop now knows about exactly one device.
  const after = desktop.status()
  assert.equal(after.devices.length, 1)
  assert.equal(after.pairing, undefined, 'a used pairing code must not stay valid')

  phone.close()
  await desktop.stop()
})

liveTest('re-pairing the same phone updates its entry instead of adding another', async () => {
  // The bug this guards: devices were keyed by peerId, which a phone picks
  // fresh on every pairing. One phone scanning twice therefore appeared as two
  // devices, and Revoke removed only one of them — leaving the other working.
  // Identity is the public key, so the same phone is the same row.
  const desktop = new RelayClient(
    join(dir, 'repair.json'),
    { handle: async () => [], onEvent: () => () => {} },
    (url: string) => new WebSocket(url) as never
  )
  await desktop.handle({ type: 'remote.set', patch: { enabled: true, relayUrl: `ws://127.0.0.1:${PORT}` } })
  for (let i = 0; i < 40 && desktop.status().state !== 'online'; i += 1) {
    await new Promise((r) => setTimeout(r, 50))
  }

  const first = decodePairing((await desktop.handle({ type: 'remote.pair' }) as { pairing: { code: string } }).pairing.code)
  assert.ok(first)
  const one = await pairPhone(first, 'peer-aaa')
  assert.ok(one.reply, 'the first pairing must succeed')
  assert.equal(desktop.status().devices.length, 1)
  const pairedAt = desktop.status().devices[0].pairedAt
  one.socket.close()

  // The same phone scans again, with a DIFFERENT peerId, as a real one would.
  const second = decodePairing((await desktop.handle({ type: 'remote.pair' }) as { pairing: { code: string } }).pairing.code)
  assert.ok(second)
  const again = await pairPhone(second, 'peer-bbb', one.keys)
  assert.ok(again.reply, 'the same phone must be able to re-pair')

  const devices = desktop.status().devices
  assert.equal(devices.length, 1, 'one phone must not become two devices')
  assert.equal(devices[0].pairedAt, pairedAt, 're-pairing keeps the original pairing date')

  again.socket.close()
  await desktop.stop()
})

liveTest('a forgotten phone cannot pair itself again', async () => {
  // Revoke must be permanent. A forgotten phone still holds the room secret
  // and can still reach the room, so without a block list it could re-pair
  // itself the moment the user next showed a code.
  const desktop = new RelayClient(
    join(dir, 'blocked.json'),
    { handle: async () => [], onEvent: () => () => {} },
    (url: string) => new WebSocket(url) as never
  )
  await desktop.handle({ type: 'remote.set', patch: { enabled: true, relayUrl: `ws://127.0.0.1:${PORT}` } })
  for (let i = 0; i < 40 && desktop.status().state !== 'online'; i += 1) {
    await new Promise((r) => setTimeout(r, 50))
  }

  const first = decodePairing((await desktop.handle({ type: 'remote.pair' }) as { pairing: { code: string } }).pairing.code)
  assert.ok(first)
  const phone = await pairPhone(first, 'peer-ccc')
  assert.ok(phone.reply, 'pairing must succeed before it can be revoked')
  const key = desktop.status().devices[0].id
  phone.socket.close()

  await desktop.handle({ type: 'remote.set', patch: { forgetDeviceId: key } })
  assert.equal(desktop.status().devices.length, 0, 'the device is gone from the list')

  // The same phone scans a fresh code. It must not get back in.
  const second = decodePairing((await desktop.handle({ type: 'remote.pair' }) as { pairing: { code: string } }).pairing.code)
  assert.ok(second)
  const retry = await pairPhone(second, 'peer-ddd', phone.keys)
  assert.equal(retry.reply, null, 'a forgotten phone must not be able to re-pair')
  assert.equal(desktop.status().devices.length, 0, 'and must not reappear in the list')

  retry.socket.close()
  await desktop.stop()
})

liveTest('a thread too large for the relay still loads, trimmed', async () => {
  // The bug, seen on a real phone: "some threads fail to load". A response
  // over the relay's 512 KB cap did not merely fail — the relay closed the
  // whole socket with 1009, taking every in-flight request with it, and the
  // phone reconnected to a thread that never opened.
  //
  // Now the desktop trims the oldest messages until the frame fits, because
  // the recent end of a transcript is the part worth reading.
  const huge = Array.from({ length: 60 }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 ? 'assistant' : 'user',
    // 20 KB each: 60 of them is ~1.2 MB, comfortably over the cap.
    parts: [{ type: 'text', text: 'x'.repeat(20_000) }]
  }))

  const desktop = new RelayClient(
    join(dir, 'huge.json'),
    { handle: async () => huge, onEvent: () => () => {} },
    (url: string) => new WebSocket(url) as never
  )
  await desktop.handle({ type: 'remote.set', patch: { enabled: true, relayUrl: `ws://127.0.0.1:${PORT}` } })
  for (let i = 0; i < 40 && desktop.status().state !== 'online'; i += 1) {
    await new Promise((r) => setTimeout(r, 50))
  }

  const payload = decodePairing((await desktop.handle({ type: 'remote.pair' }) as { pairing: { code: string } }).pairing.code)
  assert.ok(payload)
  const phone = await pairPhone(payload, 'peer-huge')
  assert.ok(phone.reply, 'pairing must succeed first')

  const roomKey = await deriveKey(crypto, String(phone.reply.secret))
  const token = String(phone.reply.token)

  const answer = new Promise<Record<string, unknown> | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 8000)
    phone.socket.on('message', async (raw: unknown) => {
      const frame = JSON.parse(String(raw)) as Record<string, unknown>
      if (typeof frame.sealed !== 'string') return
      const message = await open(crypto, roomKey, frame.sealed)
      if (message?.kind === 'response' && message.id === 'big') {
        clearTimeout(timer)
        resolve(message as unknown as Record<string, unknown>)
      }
    })
  })

  phone.socket.send(JSON.stringify({
    sealed: await seal(crypto, roomKey, {
      kind: 'request', id: 'big', token, request: { type: 'thread.messages', threadId: 't1', limit: 60 }
    })
  }))

  const reply = await answer
  assert.ok(reply, 'an oversized thread must still answer, not hang')
  assert.equal(reply.ok, true, 'and it must answer with messages, not an error')
  const list = reply.result as unknown[]
  assert.ok(list.length < huge.length, 'the response must have been trimmed to fit')
  assert.ok(list.length > 1, 'but must still carry the recent messages')

  // The socket must have SURVIVED. That is the actual bug: a 1009 close took
  // out every other request too.
  assert.equal(phone.socket.readyState, 1, 'the relay must not have closed the connection')

  phone.socket.close()
  await desktop.stop()
})
