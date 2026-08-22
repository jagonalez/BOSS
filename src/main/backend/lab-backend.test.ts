import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
// @ts-expect-error Application code uses bundler resolution.
import { normaliseLabEndpoint } from './lab-backend.ts'
// @ts-expect-error Application code uses bundler resolution.
import { LabEngine } from './lab-engine.ts'

test('normaliseLabEndpoint adds the OpenAI-compatible v1 root', () => {
  assert.equal(normaliseLabEndpoint('https://models.example.test'), 'https://models.example.test/v1')
  assert.equal(normaliseLabEndpoint('http://localhost:11434/v1/'), 'http://localhost:11434/v1')
  assert.equal(normaliseLabEndpoint('https://gateway.example.test/api/v1'), 'https://gateway.example.test/api/v1')
})

test('normaliseLabEndpoint rejects endpoints Lab cannot call safely', () => {
  assert.throws(() => normaliseLabEndpoint('models.example.test'), /valid http/i)
  assert.throws(() => normaliseLabEndpoint('file:///tmp/models'), /http/i)
  assert.throws(() => normaliseLabEndpoint('https://models.example.test/v1?token=secret'), /query/i)
})

test('Lab health checks authenticate with the configured API key', async () => {
  const originalFetch = globalThis.fetch
  let requestUrl = ''
  let authorization = ''
  globalThis.fetch = (async (input, init) => {
    requestUrl = String(input)
    authorization = new Headers(init?.headers).get('authorization') ?? ''
    return new Response(JSON.stringify({ data: [] }), { status: 200 })
  }) as typeof fetch
  try {
    const engine = new LabEngine({
      storeFile: join(tmpdir(), 'boss-lab-health-threads.json'),
      configFile: join(tmpdir(), 'boss-lab-health-config.json'),
      config: {
        baseUrl: 'https://models.example.test/v1',
        apiKey: 'test-key',
        defaultModel: 'test-model',
        contextChars: 1_000,
        maxToolIterations: 1,
        maxReadOnlyRounds: 1,
        tools: 'core'
      },
      gate: { request: async () => 'deny' }
    })
    assert.equal(await engine.checkHealth(), true)
    assert.equal(requestUrl, 'https://models.example.test/v1/models')
    assert.equal(authorization, 'Bearer test-key')
  } finally {
    globalThis.fetch = originalFetch
  }
})
