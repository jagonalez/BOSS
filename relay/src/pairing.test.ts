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

const crypto = webcrypto as never
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
  relay = spawn('node', ['dist/relay/src/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: 'ignore'
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
  assert.ok(payload.d, 'the code must carry the desktop room id')
  assert.ok(payload.j, 'the code must carry the desktop join proof')

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

  await new Promise<void>((resolve) => phone.once('open', () => resolve()))
  phone.send(JSON.stringify({
    type: 'hello', side: 'phone', deviceId: payload.d, peerId: 'test-phone', proof: payload.j, v: 1
  }))
  await new Promise((r) => setTimeout(r, 300))
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
