#!/usr/bin/env node
import { unlinkSync, writeFileSync } from 'node:fs'

const [, , command, ...args] = process.argv

if (command === 'serve') {
  const socketIndex = args.indexOf('--socket')
  const socket = socketIndex >= 0 ? args[socketIndex + 1] : ''
  if (!socket) process.exit(2)

  writeFileSync(socket, '')
  const stop = () => {
    try { unlinkSync(socket) } catch { /* already removed */ }
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  setInterval(() => {}, 60_000)
} else if (command === 'call') {
  process.stdout.write('E2E computer-use fixture completed.')
} else {
  process.exit(2)
}
