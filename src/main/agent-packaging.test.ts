import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const root = join(import.meta.dirname, '..', '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))

test('the bundled OpenCode binary matches the locked SDK release', () => {
  // CI fetches the executable separately from npm ci. Updating only one can
  // ship a client/server combination that the backend tests never exercised.
  assert.equal(
    manifest.opencodeVersion,
    `v${lock.packages['node_modules/@opencode-ai/sdk'].version}`
  )
})

test('every Claude native executable matches the locked agent SDK release', () => {
  const sdk = lock.packages['node_modules/@anthropic-ai/claude-agent-sdk']
  const binaries = Object.entries(sdk.optionalDependencies as Record<string, string>)
    .filter(([name]) => name.startsWith('@anthropic-ai/claude-agent-sdk-'))
  assert.ok(binaries.length > 0, 'the SDK must declare its native executables')
  for (const [name, version] of binaries) {
    assert.equal(version, sdk.version, `${name} must match the SDK`)
    assert.equal(lock.packages[`node_modules/${name}`]?.version, version, `${name} must be locked`)
  }
})
