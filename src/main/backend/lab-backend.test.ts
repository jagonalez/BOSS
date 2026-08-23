import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
// @ts-expect-error Application code uses bundler resolution.
import { LabBackend, normaliseLabEndpoint } from './lab-backend.ts'
// @ts-expect-error Application code uses bundler resolution.
import { LabEngine } from './lab-engine.ts'

test('normaliseLabEndpoint adds the OpenAI-compatible v1 root', () => {
  assert.equal(normaliseLabEndpoint('https://models.example.test'), 'https://models.example.test/v1')
  assert.equal(normaliseLabEndpoint('http://localhost:11434/v1/'), 'http://localhost:11434/v1')
  assert.equal(normaliseLabEndpoint('https://gateway.example.test/api/v1'), 'https://gateway.example.test/api/v1')
  assert.equal(normaliseLabEndpoint('https://gateway.example.test/openai/'), 'https://gateway.example.test/openai')
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


test('Lab exposes saved models under stable named connection ids', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'boss-lab-connections-'))
  const configFile = join(directory, 'config.json')
  writeFileSync(configFile, JSON.stringify({
    version: 2,
    connections: [{
      id: 'cloud-one',
      name: 'Cloud one',
      baseUrl: 'https://cloud.example.test/v1',
      manualModels: ['coding-model'],
      models: [{ id: 'coding-model', name: 'Coding model', source: 'custom' }]
    }]
  }))
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as typeof fetch
  const backend = new LabBackend({
    storeFile: join(directory, 'threads.json'),
    configFile,
    secretFile: join(directory, 'keys.bin')
  })
  try {
    assert.deepEqual(await backend.modelsList(), [{
      id: 'coding-model',
      name: 'Coding model',
      source: 'custom',
      provider: 'cloud-one',
      providerName: 'Cloud one'
    }])
  } finally {
    await backend.stop()
    globalThis.fetch = originalFetch
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Lab routes a selected model through its connection endpoint', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'boss-lab-routing-'))
  const configFile = join(directory, 'config.json')
  writeFileSync(configFile, JSON.stringify({
    version: 2,
    connections: [
      { id: 'local', name: 'Local', baseUrl: 'http://localhost:11434/v1', manualModels: ['local-model'], models: [{ id: 'local-model' }] },
      { id: 'cloud', name: 'Cloud', baseUrl: 'https://cloud.example.test/v1', manualModels: ['cloud-model'], models: [{ id: 'cloud-model' }] }
    ]
  }))
  const originalFetch = globalThis.fetch
  const requests: Array<{ url: string; body?: string }> = []
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), body: typeof init?.body === 'string' ? init.body : undefined })
    if (init?.method === 'POST') {
      return new Response('data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
      })
    }
    return new Response(JSON.stringify({ data: [] }), { status: 200 })
  }) as typeof fetch
  const backend = new LabBackend({
    storeFile: join(directory, 'threads.json'),
    configFile,
    secretFile: join(directory, 'keys.bin')
  })
  try {
    const session = await backend.sessionCreate('Routing test', directory)
    await backend.sendMessage(session.id, [{ type: 'text', text: 'hello' }], {
      model: { providerID: 'cloud', modelID: 'cloud-model' },
      mode: 'plan'
    })
    const completion = requests.find((request) => request.url.endsWith('/chat/completions'))
    assert.equal(completion?.url, 'https://cloud.example.test/v1/chat/completions')
    assert.equal(JSON.parse(completion?.body ?? '{}').model, 'cloud-model')
  } finally {
    await backend.stop()
    globalThis.fetch = originalFetch
    rmSync(directory, { recursive: true, force: true })
  }
})
