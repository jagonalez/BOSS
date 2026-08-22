/**
 * base64 for React Native, which ships neither btoa nor atob.
 *
 * Import this FIRST, before anything that touches the relay protocol.
 *
 * Crypto itself is NOT polyfilled here. React Native has no crypto.subtle, and
 * the obvious fix — react-native-quick-crypto — is a native module, which makes
 * the whole project unloadable in Expo Go. The protocol needs only AES-GCM and
 * SHA-256, so crypto.ts implements those with @noble in pure JavaScript and the
 * app stays runnable on a phone without a custom build.
 */
// getRandomValues, which React Native lacks and @noble needs for every nonce.
// expo-crypto directly rather than expo-standard-web-crypto: the latter pins
// expo-crypto ^14 while SDK 54 ships 15, an unresolvable peer conflict that
// broke `expo install` outright. expo-crypto is the same native implementation
// without the stale wrapper.
import { getRandomValues } from 'expo-crypto'

declare const global: Record<string, unknown>

if (typeof global.crypto !== 'object' || global.crypto === null) {
  global.crypto = {}
}
const cryptoGlobal = global.crypto as { getRandomValues?: unknown }
if (typeof cryptoGlobal.getRandomValues !== 'function') {
  cryptoGlobal.getRandomValues = getRandomValues
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

if (typeof global.btoa !== 'function') {
  global.btoa = (input: string): string => {
    let out = ''
    for (let i = 0; i < input.length; i += 3) {
      const a = input.charCodeAt(i)
      const b = input.charCodeAt(i + 1)
      const c = input.charCodeAt(i + 2)
      out += B64[a >> 2]
      out += B64[((a & 3) << 4) | (Number.isNaN(b) ? 0 : b >> 4)]
      out += Number.isNaN(b) ? '=' : B64[((b & 15) << 2) | (Number.isNaN(c) ? 0 : c >> 6)]
      out += Number.isNaN(c) ? '=' : B64[c & 63]
    }
    return out
  }
}

if (typeof global.atob !== 'function') {
  global.atob = (input: string): string => {
    const clean = input.replace(/=+$/, '')
    let out = ''
    let bits = 0
    let value = 0
    for (const char of clean) {
      const index = B64.indexOf(char)
      if (index === -1) continue
      value = (value << 6) | index
      bits += 6
      if (bits >= 8) {
        bits -= 8
        out += String.fromCharCode((value >> bits) & 0xff)
      }
    }
    return out
  }
}
