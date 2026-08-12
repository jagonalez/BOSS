import assert from 'node:assert/strict'
import test from 'node:test'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error Application code uses bundler resolution.
import { EventStream, unwrapOpenCodeEvent } from './event-stream.ts'

test('unwrapOpenCodeEvent preserves legacy events and unwraps global events', () => {
  const native = JSON.stringify({ type: 'session.idle', properties: { sessionID: 'ses_1' } })
  assert.equal(unwrapOpenCodeEvent(native), native)
  assert.deepEqual(
    JSON.parse(unwrapOpenCodeEvent(JSON.stringify({ directory: '/tmp/worktree', payload: JSON.parse(native) }))),
    JSON.parse(native)
  )
})

test('EventStream consumes the global stream for events from any directory', async (t) => {
  const originalFetch = globalThis.fetch
  let requestedUrl = ''
  globalThis.fetch = async (input) => {
    requestedUrl = String(input)
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"directory":"/tmp/worktree","payload":{"type":"session.idle","properties":{"sessionID":"ses_1"}}}\n\n'
        ))
      }
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  t.after(() => { globalThis.fetch = originalFetch })

  const stream = new EventStream({
    baseUrl: 'http://127.0.0.1:4096',
    authHeader: 'Basic test'
  } as never)
  const received = new Promise<string>((resolve) => {
    stream.onEvent = (event) => {
      resolve(event)
      stream.stop()
    }
  })
  stream.start()

  assert.deepEqual(JSON.parse(await received), {
    type: 'session.idle',
    properties: { sessionID: 'ses_1' }
  })
  assert.equal(requestedUrl, 'http://127.0.0.1:4096/global/event')
})
