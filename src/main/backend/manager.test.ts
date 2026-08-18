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
