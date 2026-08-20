import { webcrypto } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { challengeMessage, toBase64Url } from '../shared/identity'

/**
 * This desktop's relay identity: one Ed25519 keypair, generated on first use
 * and kept beside the rest of its remote-access config.
 *
 * The private key never leaves the machine, under the same rule as the agent
 * credentials. The relay only ever sees the public key and signatures over
 * nonces it issued itself, so a compromise of the relay host yields nothing
 * that can impersonate this desktop.
 *
 * Separate from the room secret in relay-client.ts, which still derives the
 * AES key that seals frames. Encryption and identity are different jobs: the
 * secret is shared with paired phones, and this key must never be.
 */

const crypto = webcrypto as unknown as {
  subtle: {
    generateKey(a: { name: string }, extractable: boolean, usages: string[]): Promise<{ publicKey: object; privateKey: object }>
    exportKey(format: 'raw' | 'pkcs8', key: object): Promise<ArrayBuffer>
    importKey(format: 'raw' | 'pkcs8', data: ArrayBufferView, a: { name: string }, extractable: boolean, usages: string[]): Promise<object>
    sign(a: { name: string }, key: object, data: ArrayBufferView): Promise<ArrayBuffer>
  }
}

interface StoredKeypair {
  /** base64url pkcs8. Private — the file sits in userData beside the config. */
  privateKey: string
  /** base64url raw. Published to the relay on every connection. */
  publicKey: string
}

export class RelayIdentity {
  private readonly file: string
  private keys?: { privateKey: object; publicKey: string }

  constructor(file: string) {
    this.file = file
  }

  /** Generates on first call and reuses thereafter, so the room id is stable. */
  private async load(): Promise<{ privateKey: object; publicKey: string }> {
    if (this.keys) return this.keys

    if (existsSync(this.file)) {
      try {
        const stored = JSON.parse(readFileSync(this.file, 'utf8')) as StoredKeypair
        const privateKey = await crypto.subtle.importKey(
          'pkcs8',
          decode(stored.privateKey),
          { name: 'Ed25519' },
          false,
          ['sign']
        )
        this.keys = { privateKey, publicKey: stored.publicKey }
        return this.keys
      } catch {
        // A damaged file loses the room, which costs a re-pair. Better than
        // refusing to start: the user can always scan again.
      }
    }

    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
    const publicKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)))
    const privateKeyBytes = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
    try {
      writeFileSync(this.file, JSON.stringify({ privateKey: toBase64Url(privateKeyBytes), publicKey }, null, 2), {
        mode: 0o600
      })
    } catch {
      // Without persistence the desktop gets a new room every launch, which
      // re-pairs every phone. Worth reporting, not worth refusing to run.
    }
    // Re-import non-extractable: nothing after this needs to export it again.
    const privateKey = await crypto.subtle.importKey('pkcs8', privateKeyBytes, { name: 'Ed25519' }, false, ['sign'])
    this.keys = { privateKey, publicKey }
    return this.keys
  }

  async publicKey(): Promise<string> {
    return (await this.load()).publicKey
  }

  /** Sign a relay challenge. The room and side are bound into the message, so
   *  the result cannot be replayed into another room or as another side. */
  async sign(nonce: string, roomId: string, side: 'desktop' | 'phone'): Promise<string> {
    const { privateKey } = await this.load()
    const signature = await crypto.subtle.sign(
      { name: 'Ed25519' },
      privateKey,
      challengeMessage(nonce, roomId, side)
    )
    return toBase64Url(new Uint8Array(signature))
  }
}

function decode(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  return new Uint8Array(Buffer.from(base64 + '='.repeat((4 - (base64.length % 4)) % 4), 'base64'))
}
