import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// @ts-expect-error Application code uses bundler resolution.
import * as bus from './thread-bus.ts'

test('no tool description names the app', () => {
  // The app and the standing assistant share the name BOSS. A tool that says
  // "another BOSS thread" tells the assistant that BOSS is the system around
  // it, so asked "are you BOSS?" it answered no. Describe what the tool does;
  // the agent does not need to know what the surrounding app is called.
  const all = Object.entries(bus as Record<string, unknown>).filter(([name]) =>
    name.endsWith('TOOL_DESCRIPTIONS')
  )
  assert.ok(all.length >= 5, 'found the description groups')
  for (const [group, texts] of all) {
    for (const [key, text] of Object.entries(texts as Record<string, unknown>)) {
      if (typeof text !== 'string') continue
      assert.doesNotMatch(text, /\bBOSS\b/, `${group}.${key} names the app`)
    }
  }
})

test('every backend offers the tool that starts a room', () => {
  // Five backends declare their tools by hand, and BOSS runs on any of them.
  // A tool added to one and forgotten on another means the assistant can offer
  // a room on Claude and not on Codex — the same conversation, a different
  // answer, for a reason the user cannot see.
  const files = [
    'src/main/thread-bus.ts',
    'src/main/backend/claude-backend.ts',
    'src/main/backend/codex-backend.ts',
    'src/main/backend/lab-thread-tools.ts',
    'src/main/backend/pi-backend.ts',
    'src/main/opencode-server.ts'
  ]
  for (const file of files) {
    const source = readFileSync(join(process.cwd(), file), 'utf8')
    assert.match(source, /boss_rooms_open/, `${file} offers the room tool`)
  }
})
