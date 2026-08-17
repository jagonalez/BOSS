/**
 * Browser APIs the relay protocol needs, which React Native does not ship.
 *
 * Import this FIRST, before anything that touches crypto. Verified against the
 * installed packages rather than assumed: React Native provides no
 * `crypto.subtle`, no `btoa`, and no `atob`, and expo-standard-web-crypto
 * supplies only `getRandomValues`. Without these the first sealed frame throws.
 */
import 'react-native-get-random-values'
import { Buffer } from '@craftzdog/react-native-buffer'
import QuickCrypto from 'react-native-quick-crypto'

declare const global: Record<string, unknown>

// AES-GCM, SHA-256, and importKey come from quick-crypto; getRandomValues is
// already present via react-native-get-random-values.
if (!(globalThis.crypto as Crypto | undefined)?.subtle) {
  globalThis.crypto = {
    ...(globalThis.crypto ?? {}),
    getRandomValues: globalThis.crypto?.getRandomValues?.bind(globalThis.crypto) ?? QuickCrypto.getRandomValues,
    subtle: QuickCrypto.subtle
  } as Crypto
}

// base64, used for every device id, proof, and sealed frame.
if (typeof global.btoa !== 'function') {
  global.btoa = (input: string): string => Buffer.from(input, 'binary').toString('base64')
}
if (typeof global.atob !== 'function') {
  global.atob = (input: string): string => Buffer.from(input, 'base64').toString('binary')
}
