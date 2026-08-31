import assert from 'node:assert/strict'
import test from 'node:test'
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
