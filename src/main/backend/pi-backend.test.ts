import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Pi spawns a process, so its wiring is checked by reading the source rather
 *  than by starting one. What matters is the argument list. */
const source = readFileSync(join(import.meta.dirname, 'pi-backend.ts'), 'utf8')

test('standing instructions are added to pi rather than replacing its own', () => {
  // Pi has flags for both. What BOSS has to say is about where the agent is and
  // who it is, not about how to write code, so replacing pi's own instructions
  // would throw away the part it is good at.
  assert.match(source, /'--append-system-prompt', this\.standing/)
  assert.doesNotMatch(source, /'--system-prompt'/)
})

test('pi is given its instructions when it starts, because that is its only moment', () => {
  // The runtime is spawned once per conversation and has no way to be told
  // anything later.
  const start = source.indexOf('private async runtime(sessionId: string')
  assert.ok(start > 0, 'expected the runtime factory')
  const body = source.slice(start, source.indexOf('\n  }', start))
  assert.match(body, /standing/, 'the factory passes them through to the spawn')

  const send = source.indexOf('async sendMessage(sessionId: string')
  const sendBody = source.slice(send, source.indexOf('\n  }', send))
  assert.match(sendBody, /this\.runtime\(sessionId, options\?\.context\)/,
    'and the send is where they come from')
})

test('a running pi keeps the instructions it started with', () => {
  // Said plainly in the code, because it is a real limit: a thread that moves
  // to a different copy of the code keeps describing the old one.
  const start = source.indexOf('private readonly standing?: string')
  assert.ok(start > 0, 'expected the field')
  const above = source.slice(Math.max(0, start - 400), start)
  assert.match(above, /started once per conversation/, 'the limit is written down where it applies')
})
