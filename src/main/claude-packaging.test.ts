import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

test('leaves the Claude SDK native binary out of the packaged app', () => {
  const packageJson = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8')) as {
    build?: { files?: string[]; asarUnpack?: string[] }
  }
  // BOSS runs the user's installed claude, so a new model works when that CLI
  // updates. The SDK's own 300 MB binary would only be dead weight.
  assert.ok(
    packageJson.build?.files?.includes('!node_modules/@anthropic-ai/claude-agent-sdk-*/**'),
    'the SDK platform package must be excluded from the packaged app'
  )
  assert.ok(
    !packageJson.build?.asarUnpack?.some((pattern) => pattern.includes('claude-agent-sdk')),
    'nothing should unpack a binary that is no longer shipped'
  )
})
