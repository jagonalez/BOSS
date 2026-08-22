import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
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
  const directory = mkdtempSync(join(tmpdir(), 'boss-lab-health-'))
  const server = createServer((request, response) => {
    if (request.headers.authorization === 'Bearer test-key') {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ data: [] }))
      return
    }
    response.writeHead(401)
    response.end()
  })
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Test server did not bind a port.')
    const engine = new LabEngine({
      storeFile: join(directory, 'threads.json'),
      configFile: join(directory, 'config.json'),
      config: {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
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
  } finally {
    // fetch may leave an idle keep-alive socket in its global dispatcher. Do
    // not let that socket keep Node's test runner alive on CI.
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(directory, { recursive: true, force: true })
  }
})
