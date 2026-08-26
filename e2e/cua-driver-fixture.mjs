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
  const [tool, rawArguments] = args
  process.stdout.write(JSON.stringify({
    tool,
    arguments: JSON.parse(rawArguments ?? '{}')
  }))
} else {
  process.exit(2)
}
