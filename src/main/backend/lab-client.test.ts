import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import test from 'node:test'
import type { AddressInfo } from 'node:net'
// @ts-expect-error Application code uses bundler resolution.
import { listModels, streamChatCompletion, StreamText } from './lab-client.ts'

function withServer(
  handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void,
  run: (baseUrl: string, server: Server) => Promise<void> | void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve(
        Promise.resolve(run(`http://127.0.0.1:${port}/v1`, server)).catch(reject).finally(() => server.close())
      )
    })
    server.on('error', reject)
  })
}

const chunk = (delta: Record<string, unknown>, finishReason: string | null = null): string =>
  `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finishReason }] })}\n\n`

test('streamChatCompletion accumulates text across streamed chunks', async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(chunk({ content: 'Hel' }))
    res.write(chunk({ content: 'lo' }))
    res.write(chunk({ content: ' world' }, 'stop'))
    res.write('data: [DONE]\n\n')
    res.end()
  }, async (baseUrl) => {
    const result = await streamChatCompletion({ baseUrl, model: 'm', messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(result.content, 'Hello world')
    assert.deepEqual(result.toolCalls, [])
  })
})

test('streamChatCompletion handles servers that resend the whole message each chunk', async () => {
  // Some local endpoints (ollama-style proxies) send cumulative snapshots.
  await withServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(chunk({ content: 'Hey' }))
    res.write(chunk({ content: 'Hey!' }))
    res.write(chunk({ content: 'Hey! Looks' }))
    res.write(chunk({ content: 'Hey! Looks like this.' }, 'stop'))
    res.write('data: [DONE]\n\n')
    res.end()
  }, async (baseUrl) => {
    const deltas: string[] = []
    const result = await streamChatCompletion({ baseUrl, model: 'm', messages: [], onText: (delta) => deltas.push(delta) })
    assert.equal(result.content, 'Hey! Looks like this.')
    assert.deepEqual(deltas, ['Hey', '!', ' Looks', ' like this.'])
  })
})

test('StreamText returns only the new portion of cumulative snapshots', () => {
  const tracker = new StreamText()
  assert.equal(tracker.push('hello'), 'hello')
  assert.equal(tracker.push('hello world'), ' world')
  assert.equal(tracker.push('hello world again'), ' again')
  assert.equal(tracker.value, 'hello world again')
  // In cumulative mode a short chunk is not an extension and is dropped.
  assert.equal(tracker.push('x'), '')
  assert.equal(tracker.value, 'hello world again')
})

test('StreamText keeps spec deltas intact', () => {
  const tracker = new StreamText()
  assert.equal(tracker.push('Hel'), 'Hel')
  assert.equal(tracker.push('lo'), 'lo')
  assert.equal(tracker.push(' world'), ' world')
  assert.equal(tracker.value, 'Hello world')
})

test('StreamText survives a leading whitespace-noise chunk', () => {
  // The exact failure from a real local server: a space chunk, then cumulative
  // snapshots. The old startsWith heuristic doubled forever from here.
  const tracker = new StreamText()
  assert.equal(tracker.push(' '), '')
  assert.equal(tracker.push('The'), 'The')
  assert.equal(tracker.push('The working'), ' working')
  assert.equal(tracker.push('The working tree'), ' tree')
  assert.equal(tracker.value, 'The working tree')
})

test('streamChatCompletion returns reassembled tool calls', async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(chunk({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"path":' } }] }))
    res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: '"x.txt"}' } }] }))
    res.write(chunk({}, 'tool_calls'))
    res.write('data: [DONE]\n\n')
    res.end()
  }, async (baseUrl) => {
    const result = await streamChatCompletion({ baseUrl, model: 'm', messages: [{ role: 'user', content: 'inspect' }] })
    assert.equal(result.content, '')
    assert.equal(result.toolCalls.length, 1)
    assert.equal(result.toolCalls[0].id, 'call_1')
    assert.equal(result.toolCalls[0].name, 'read_file')
    assert.equal(result.toolCalls[0].arguments, '{"path":"x.txt"}')
  })
})

test('streamChatCompletion accumulates reasoning deltas alongside text', async () => {
  const seenReasoning: string[] = []
  await withServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(chunk({ reasoning_content: 'think' }))
    res.write(chunk({ reasoning_content: 'ing' }))
    res.write(chunk({ content: 'answer' }, 'stop'))
    res.write('data: [DONE]\n\n')
    res.end()
  }, async (baseUrl) => {
    const result = await streamChatCompletion({
      baseUrl,
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      onReasoning: (delta) => seenReasoning.push(delta)
    })
    assert.equal(result.reasoning, 'thinking')
    assert.equal(result.content, 'answer')
    assert.deepEqual(seenReasoning, ['think', 'ing'])
  })
})

test('streamChatCompletion returns empty reasoning when none streams', async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(chunk({ content: 'plain' }, 'stop'))
    res.write('data: [DONE]\n\n')
    res.end()
  }, async (baseUrl) => {
    const result = await streamChatCompletion({ baseUrl, model: 'm', messages: [] })
    assert.equal(result.reasoning, '')
  })
})

test('streamChatCompletion delivers live text and tool-call delta callbacks', async () => {
  const seenText: string[] = []
  const seenToolArgs: string[] = []
  await withServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(chunk({ content: 'a' }))
    res.write(chunk({ tool_calls: [{ index: 0, function: { name: 'bash', arguments: '{"command"' } }] }))
    res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: '":"ls"}' } }] }))
    res.write('data: [DONE]\n\n')
    res.end()
  }, async (baseUrl) => {
    await streamChatCompletion({
      baseUrl,
      model: 'm',
      messages: [],
      onText: (delta) => seenText.push(delta),
      onToolCallDelta: (delta) => { if (delta.arguments !== undefined) seenToolArgs.push(delta.arguments) }
    })
    assert.deepEqual(seenText, ['a'])
    assert.deepEqual(seenToolArgs, ['{"command"', '":"ls"}'])
  })
})

test('streamChatCompletion throws with status detail on a non-2xx response', async () => {
  await withServer((_req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'model not found' } }))
  }, async (baseUrl) => {
    await assert.rejects(
      streamChatCompletion({ baseUrl, model: 'missing', messages: [] }),
      /404:.*model not found/
    )
  })
})

test('streamChatCompletion aborts the in-flight request via AbortController', async () => {
  let released = false
  await withServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(chunk({ content: 'partial' }))
    res.on('close', () => {
      released = true
      res.destroy()
    })
  }, async (baseUrl) => {
    const controller = new AbortController()
    const pending = streamChatCompletion({ baseUrl, model: 'm', messages: [], signal: controller.signal })
    // Give the first chunk a moment to land, then interrupt.
    await new Promise((resolve) => setTimeout(resolve, 50))
    controller.abort()
    await assert.rejects(pending, (error: unknown) => (error as Error).name === 'AbortError')
    // Give the server a tick to observe the socket closing.
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(released, true)
  })
})

test('listModels reads ollama /api/tags when present', async () => {
  await withServer((req, res) => {
    if (req.url === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ models: [{ name: 'llama3.1' }, { name: 'qwen2.5-coder:latest' }] }))
      return
    }
    res.writeHead(404)
    res.end()
  }, async (baseUrl) => {
    const models = await listModels(baseUrl)
    assert.deepEqual(models.map((model) => model.id).sort(), ['llama3.1', 'qwen2.5-coder:latest'])
    assert.equal(models[0].provider, 'ollama')
  })
})

test('listModels falls back to OpenAI /v1/models', async () => {
  await withServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'gpt-5.6', name: 'GPT-5.6' }] }))
      return
    }
    res.writeHead(404)
    res.end()
  }, async (baseUrl) => {
    const models = await listModels(baseUrl)
    assert.deepEqual(models.map((model) => model.id), ['gpt-5.6'])
    assert.equal(models[0].source, 'cloud')
  })
})

test('listModels returns [] when the endpoint is unreachable', async () => {
  await withServer((_req, res) => {
    res.writeHead(500)
    res.end()
  }, async (baseUrl) => {
    const models = await listModels(baseUrl)
    assert.deepEqual(models, [])
  })
})

test('streamChatCompletion times out when the server stalls', async () => {
  await withServer((_req, res) => {
    // Never respond; the client must give up on its own.
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.on('close', () => res.destroy())
  }, async (baseUrl) => {
    await assert.rejects(
      streamChatCompletion({ baseUrl, model: 'm', messages: [], timeoutMs: 120 }),
      (error: unknown) => (error as Error).name === 'TimeoutError'
    )
  })
})