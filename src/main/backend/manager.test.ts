import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The manager imports @shared and electron as values, aliases only the bundler
 *  resolves, so the class cannot be constructed here. Reading the source holds
 *  the wiring in place: the risk is a busy refusal quietly going back to being
 *  treated as a failed run, and that is visible in the text. */
const source = readFileSync(join(import.meta.dirname, 'manager.ts'), 'utf8')

function sendMessageCatch(): string {
  const start = source.indexOf('async sendMessage(threadId: string')
  assert.ok(start > 0, 'expected a sendMessage method')
  const catchStart = source.indexOf('} catch (error) {', start)
  assert.ok(catchStart > 0, 'expected a catch block in sendMessage')
  return source.slice(catchStart, source.indexOf('\n  }', catchStart))
}

test('a backend that refuses because it is still running does not settle the live run', () => {
  // A backend frees its own turn slot after main clears busyThreads, so a
  // message sent in that gap reaches the backend and is refused. Settling it
  // marked the running parts interrupted and announced idle over a thread that
  // was still streaming — and messagesList prunes whatever the backend does not
  // report once a thread is idle, which deleted the message the user had just
  // sent. That is the same fault as the steered Codex message, on the send path.
  const block = sendMessageCatch()
  const guard = block.indexOf('THREAD_BUSY_ERROR')
  assert.ok(guard > 0, 'the catch must recognise a busy refusal')
  assert.ok(
    guard < block.indexOf('finishRun'),
    'a busy refusal must rethrow before the run is settled as an error'
  )
  assert.ok(
    guard < block.indexOf('busyThreads.delete'),
    'a busy refusal must rethrow before the thread is marked idle'
  )
})

test('a follow-up refused as busy stays queued and reports nothing', () => {
  // Only a delivered follow-up is filtered out of the queue, so a refused one
  // is still there for the idle handler to deliver. Emitting session.error for
  // it showed the user the raw busy marker for a message that was about to be
  // sent anyway.
  const start = source.indexOf('private async deliverNextFollowUp(')
  assert.ok(start > 0, 'expected deliverNextFollowUp')
  const body = source.slice(start, source.indexOf('\n  }', source.indexOf('} finally {', start)))
  const guard = body.indexOf('THREAD_BUSY_ERROR')
  assert.ok(guard > 0, 'delivery must recognise a busy refusal')
  assert.ok(
    guard < body.indexOf("type: 'session.error'"),
    'a busy refusal must return before session.error is emitted'
  )
  assert.ok(
    /includes\(THREAD_BUSY_ERROR\)\) return/.test(body),
    'a busy refusal must leave the follow-up queued rather than reporting it'
  )
})

test('stopping a run delivers the message queued against it', () => {
  // Interrupting a thread settles the run inside abort() rather than waiting
  // for an idle event the backend may never send. But emit() only fans out to
  // renderers — it does not re-enter the handler that normally drains the
  // queue. So a message the user typed while the run was still streaming, which
  // sendPrompt queued because the thread was busy, sat there after the stop and
  // looked to the user like it had vanished.
  const start = source.indexOf('async abort(threadId: string')
  assert.ok(start > 0, 'expected an abort method')
  const body = source.slice(start, source.indexOf('\n  async ', start + 10))
  assert.ok(
    body.includes('deliverNextFollowUp'),
    'aborting must drain the follow-up queue, or a steered message is stranded'
  )
  assert.ok(
    body.indexOf('busyThreads.delete') < body.indexOf('deliverNextFollowUp'),
    'the thread must be clear of busy first, or delivery refuses itself'
  )
})

test('a send that fails for any reason does not arm the transcript prune', () => {
  // Pruning hard-deletes every stored message the backend does not report. A
  // failed send means BOSS recorded a message the backend never received, so
  // its history is not the whole truth — clearing busy without suspending the
  // prune let the next reload delete the message the user had just sent. Only
  // the busy refusal returned early, so every other throw (network, auth,
  // transport) hit this.
  const block = sendMessageCatch()
  const suspend = block.indexOf('pruneSuspended.add')
  assert.ok(suspend > 0, 'a failed send must suspend the prune')
  assert.ok(
    suspend < block.indexOf('busyThreads.delete'),
    'the prune must be suspended before the thread is marked idle'
  )
})

test('the prune requires both an idle thread and a trustworthy history', () => {
  const start = source.indexOf('async messagesList(threadId: string')
  assert.ok(start > 0, 'expected messagesList')
  const body = source.slice(start, source.indexOf('\n  async ', start + 10))
  assert.ok(
    /pruneMissingMessages:\s*!this\.busyThreads\.has\(threadId\)\s*&&\s*!this\.pruneSuspended\.has\(threadId\)/.test(body),
    'pruning must check pruneSuspended as well as busyThreads'
  )
})

test('a send that reaches the backend restores pruning', () => {
  // Left suspended, one failed send would disable pruning for the life of the
  // thread and let genuinely-removed messages linger for ever.
  const start = source.indexOf('async sendMessage(threadId: string')
  const body = source.slice(start, source.indexOf('    try {', start))
  assert.ok(
    body.includes('pruneSuspended.delete'),
    'starting a run must clear the suspension'
  )
})
