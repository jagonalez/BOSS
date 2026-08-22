import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
// @ts-expect-error Application code uses bundler resolution.
import { createAcpEngine, LabAcpServer } from './lab-acp.ts'

const chunk = (obj: Record<string, unknown>): string => `data: ${JSON.stringify({ choices: [{ delta: obj, finish_reason: null }] })}\n\n`
const done = (): string => 'data: [DONE]\n\n'
const textChunk = (text: string): string => chunk({ content: text })
const toolCallChunk = (name: string, args: string): string =>
  chunk({ tool_calls: [{ index: 0, id: `call-${name}`, function: { name, arguments: args } }] })

interface AcpFixture {
  server: LabAcpServer
  out: Record<string, unknown>[]
  cleanup: () => void
}

function makeFixture(chatResponses: Array<(res: ServerResponse) => void>): Promise<AcpFixture> {
  const dir = mkdtempSync(join(tmpdir(), 'lab-acp-'))
  const originalBaseUrl = process.env.LAB_BASE_URL
  let chatIndex = 0
  const server = createServer((req, res) => {
    if (req.url === '/v1/chat/completions') {
      const writer = chatResponses[chatIndex++]
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (writer) writer(res)
      else res.on('close', () => res.destroy())
      return
    }
    res.writeHead(404)
    res.end()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      process.env.LAB_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
      const out: Record<string, unknown>[] = []
      const bundle = createAcpEngine((value) => out.push(value), {
        storeFile: join(dir, 'threads.json'),
        configFile: join(dir, 'config.json')
      })
      const acp = new LabAcpServer(bundle.engine, bundle.sessionId, (value) => out.push(value), bundle.pendingPermissions)
      resolve({
        server: acp,
        out,
        cleanup: () => {
          process.env.LAB_BASE_URL = originalBaseUrl
          server.close()
          rmSync(dir, { recursive: true, force: true })
        }
      })
    })
  })
}

function poll<T>(check: () => T, until: (value: T) => boolean, timeoutMs = 4_000): Promise<void> {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      let value: T
      try { value = check() } catch { value = undefined as unknown as T }
      if (until(value)) return resolve()
      if (Date.now() - start > timeoutMs) return reject(new Error('timed out waiting for condition'))
      setTimeout(tick, 20)
    }
    tick()
  })
}

test('acp server streams a reply and closes with a result', async () => {
  const fx = await makeFixture([(res) => {
    res.write(textChunk('hello'))
    res.write(textChunk(' world'))
    res.write(done())
    res.end()
  }])
  try {
    fx.server.handleLine(JSON.stringify({ type: 'control_request', request_id: 'r1', request: { subtype: 'initialize' } }))
    assert.ok(fx.out.some((line) => line.type === 'control_response' && (line as { response?: { subtype?: string } }).response?.subtype === 'success'))

    fx.out.length = 0
    fx.server.handleLine(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }))

    await poll(() => fx.out, (lines) => lines.some((line) => line.type === 'result'))
    const deltas = fx.out.filter((line) => line.type === 'stream_event')
      .map((line) => (line as { event?: { delta?: { text?: string } } }).event?.delta?.text ?? '')
    assert.deepEqual(deltas, ['hello', ' world'])
    const assistant = fx.out.find((line) => line.type === 'assistant') as { message?: { content?: Array<{ type?: string; text?: string }> } } | undefined
    assert.equal(assistant?.message?.content?.[0]?.text, 'hello world')
    assert.ok(fx.out.some((line) => line.type === 'result' && line.subtype === 'success'))
  } finally {
    fx.cleanup()
  }
})

test('acp server asks permission and delivers the tool result', async () => {
  const fx = await makeFixture([
    (res) => { res.write(toolCallChunk('bash', '{"command":"echo hi"}')); res.write(done()); res.end() },
    (res) => { res.write(textChunk('done')); res.write(done()); res.end() }
  ])
  try {
    fx.server.handleLine(JSON.stringify({ type: 'control_request', request_id: 'r1', request: { subtype: 'set_permission_mode', mode: 'manual' } }))
    fx.out.length = 0

    fx.server.handleLine(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'run a command' }] } }))

    await poll(() => fx.out, (lines) => lines.some((line) => line.type === 'control_request'))
    const request = fx.out.find((line) => line.type === 'control_request') as { request_id?: string; request?: { tool_name?: string } } | undefined
    assert.equal(request?.request?.tool_name, 'bash')

    fx.server.handleLine(JSON.stringify({
      type: 'control_response',
      response: { subtype: 'success', request_id: request?.request_id, response: { behavior: 'allow', updatedInput: { command: 'echo hi' } } }
    }))

    await poll(() => fx.out, (lines) => lines.some((line) => line.type === 'result'))
    const toolResult = fx.out.find((line) => line.type === 'user') as { message?: { content?: Array<{ type?: string; content?: string }> } } | undefined
    assert.equal(toolResult?.message?.content?.[0]?.type, 'tool_result')
    assert.match(toolResult?.message?.content?.[0]?.content ?? '', /hi/)
    assert.ok(fx.out.some((line) => line.type === 'result' && line.subtype === 'success'))
  } finally {
    fx.cleanup()
  }
})