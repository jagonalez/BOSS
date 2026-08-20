import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

test('unpacks the Claude SDK native package for Electron child_process', () => {
  const packageJson = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8')) as {
    build?: { asarUnpack?: string[] }
  }
  assert.ok(
    packageJson.build?.asarUnpack?.includes('node_modules/@anthropic-ai/claude-agent-sdk-*/**'),
    'the SDK platform package must be outside app.asar so its native claude binary can spawn'
  )
})
