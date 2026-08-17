import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
// @ts-expect-error TypeScript rejects the .ts extension in an emitting project,
// but node --test needs it to load the module. The other tests here do the same.
import { TerminalThrottle, FLUSH_INTERVAL_MS, HIGH_WATERMARK_CHARS, LOW_WATERMARK_CHARS } from './terminal-throttle.ts'

function harness(options: { started?: boolean } = {}): {
  throttle: TerminalThrottle
  emitted: string[]
  paused: () => boolean
} {
  const emitted: string[] = []
  let paused = false
  const throttle = new TerminalThrottle({
    emit: (data) => emitted.push(data),
    pause: () => {
      paused = true
    },
    resume: () => {
      paused = false
    }
  })
  // Most tests care about pacing rather than startup, so they begin released.
  if (options.started !== false) throttle.start()
  return { throttle, emitted, paused: () => paused }
}

test('output written before the renderer is listening is held, not lost', async () => {
  // The shell prints its prompt the moment it spawns, which is before the
  // renderer has the id to match it against. Dropping it left a blank terminal.
  const { throttle, emitted } = harness({ started: false })
  throttle.push('jeremy@mac ~ %ate')
  await delay(FLUSH_INTERVAL_MS * 4)
  assert.deepEqual(emitted, [], 'nothing should go out before start()')

  throttle.start()
  assert.deepEqual(emitted, ['jeremy@mac ~ %ate'], 'start() should release the prompt')
})

test('starting twice does not resend what was already delivered', () => {
  const { throttle, emitted } = harness({ started: false })
  throttle.push('prompt')
  throttle.start()
  throttle.start()
  assert.deepEqual(emitted, ['prompt'])
})

test('a flood before the renderer is ready is capped, keeping the newest output', () => {
  const { throttle, emitted } = harness({ started: false })
  throttle.push('the oldest line, long since scrolled away')
  for (let i = 0; i < 12; i += 1) throttle.push('x'.repeat(10_000))
  throttle.push('the prompt you actually see')
  throttle.start()

  const sent = emitted.join('')
  assert.ok(sent.length <= HIGH_WATERMARK_CHARS + 10_000, `held ${sent.length} chars`)
  assert.ok(sent.endsWith('the prompt you actually see'), 'the newest output must survive')
  assert.ok(!sent.includes('the oldest line'), 'the oldest output should be dropped first')
})

test('starting with nothing held sends nothing', () => {
  const { throttle, emitted } = harness({ started: false })
  throttle.start()
  assert.deepEqual(emitted, [])
})

test('chunks arriving together leave as one message', async () => {
  const { throttle, emitted } = harness()
  for (const chunk of ['a', 'b', 'c']) throttle.push(chunk)
  assert.deepEqual(emitted, [], 'nothing should be sent before the flush')
  await delay(FLUSH_INTERVAL_MS * 4)
  assert.deepEqual(emitted, ['abc'])
})

test('steady output still draws, rather than deferring forever', async () => {
  // The timer is armed by the first chunk and never pushed back, so a shell
  // writing continuously is still flushed on schedule.
  const { throttle, emitted } = harness()
  const stop = Date.now() + 40
  let written = 0
  while (Date.now() < stop) {
    throttle.push('x')
    written += 1
    await delay(1)
  }
  await delay(FLUSH_INTERVAL_MS * 4)
  assert.ok(emitted.length > 1, `expected several flushes, got ${emitted.length}`)
  assert.equal(emitted.join('').length, written, 'every chunk should arrive exactly once')
})

test('a flush with nothing pending sends no empty message', async () => {
  const { throttle, emitted } = harness()
  throttle.flush()
  await delay(FLUSH_INTERVAL_MS * 2)
  assert.deepEqual(emitted, [])
})

test('the shell is paused once the renderer falls far enough behind', () => {
  const { throttle, paused } = harness()
  throttle.push('x'.repeat(HIGH_WATERMARK_CHARS + 1))
  throttle.flush()
  assert.equal(paused(), true)
})

test('output below the watermark never pauses the shell', () => {
  const { throttle, paused } = harness()
  throttle.push('x'.repeat(HIGH_WATERMARK_CHARS - 1))
  throttle.flush()
  assert.equal(paused(), false)
})

test('the shell resumes only once the backlog is nearly drained', () => {
  const { throttle, paused } = harness()
  throttle.push('x'.repeat(HIGH_WATERMARK_CHARS + 1))
  throttle.flush()
  assert.equal(paused(), true)

  // Acknowledging most of it is not enough. Resuming at the high watermark
  // would stutter between pause and resume on every batch.
  throttle.acknowledge(HIGH_WATERMARK_CHARS - LOW_WATERMARK_CHARS)
  assert.equal(paused(), true, 'should stay paused above the low watermark')

  throttle.acknowledge(LOW_WATERMARK_CHARS + 1)
  assert.equal(paused(), false)
})

test('acknowledging more than was sent does not strand the shell', () => {
  const { throttle, paused } = harness()
  throttle.push('x'.repeat(HIGH_WATERMARK_CHARS + 1))
  throttle.flush()
  throttle.acknowledge(HIGH_WATERMARK_CHARS * 10)
  assert.equal(paused(), false)
})

test('discarding drops the batch instead of emitting it later', async () => {
  const { throttle, emitted } = harness()
  throttle.push('output for a closed tab')
  throttle.discard()
  await delay(FLUSH_INTERVAL_MS * 4)
  assert.deepEqual(emitted, [])
})
