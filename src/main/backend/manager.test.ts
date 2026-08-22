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

test('steering twice keeps both messages, in the order they were steered', () => {
  // Promoting a steered follow-up to index 0 was the bug behind the vanishing
  // message. Only followUps[0] is ever delivered, so steering a second message
  // while the first was still waiting for its abort put the second in front —
  // and the first sat behind it, undelivered, looking to the user like it had
  // been swallowed. A steered item must land after the ones already steered.
  const start = source.indexOf('private promoteFollowUp(')
  assert.ok(start > 0, 'expected a promoteFollowUp helper')
  const body = source.slice(start, source.indexOf('\n  }', start))
  assert.ok(
    body.includes('steeredAt'),
    'promotion must record that the item was steered, or order cannot be kept'
  )
  assert.ok(
    /while \(to < list\.length && list\[to\]\.steeredAt !== undefined\) to \+= 1/.test(body),
    'a steered item must be inserted after the already-steered ones, not at index 0'
  )
})

test('steering never rebuilds the queue with the item at the front', () => {
  // The two spots that used to do this by hand are exactly where a second
  // steer overtook the first. Both must go through promoteFollowUp.
  const start = source.indexOf('async steerFollowUp(threadId: string')
  assert.ok(start > 0, 'expected steerFollowUp')
  const body = source.slice(start, source.indexOf('\n  /** Move a steered follow-up', start))
  assert.ok(
    !/binding\.followUps = \[item, \.\.\./.test(body),
    'steering must not promote to index 0; that is what dropped the first message'
  )
  assert.equal(
    body.split('this.promoteFollowUp(').length - 1,
    3,
    'every steer path (idle, native-steer failure, stop-and-redirect) must promote the same way'
  )
})

test('a native steer the backend refuses leaves the message queued', () => {
  // The run can end between the click and the call, and the backend then has
  // no turn left to fold the text into and throws. Letting that throw escape
  // dropped a message the backend had never accepted — the user saw it leave
  // the queue and appear nowhere.
  const start = source.indexOf('async steerFollowUp(threadId: string')
  const body = source.slice(start, source.indexOf('\n  /** Move a steered follow-up', start))
  const steer = body.indexOf('await backend.steer(')
  assert.ok(steer > 0, 'expected a native steer call')
  const guard = body.indexOf('} catch (error) {', steer)
  assert.ok(guard > 0, 'a refused native steer must be caught, not left to escape')
  const recovery = body.slice(guard)
  assert.ok(
    recovery.indexOf('promoteFollowUp') < recovery.indexOf('deliverNextFollowUp'),
    'the refused message must be promoted before delivery is retried'
  )
  assert.ok(
    recovery.includes('deliverNextFollowUp'),
    'a refused steer must fall back to sending the message as the next one'
  )
})

test('an image part joins a real message instead of one invented for it', () => {
  // groupTurns closes a turn only on a user message, so an assistant message
  // that nothing else shares never ends one: an image given a fresh messageID
  // stayed in the open turn and was drawn again under every later reply until
  // the user spoke. That is the repeated-screenshot report. The image has to
  // land in the message that produced it.
  const start = source.indexOf('private emitImagePart(')
  assert.ok(start > 0, 'expected an emitImagePart method')
  const body = source.slice(start, source.indexOf('\n  }', start))
  assert.ok(
    !/messageID:\s*`assistant-tool-image-\$\{randomUUID\(\)\}`/.test(body),
    'emitImagePart must not mint a message id as its default'
  )
  assert.ok(body.includes('messageID: owner'), 'the part should take the resolved owner')
  assert.ok(
    body.includes('messageId ?? binding.lastAssistantMessageId'),
    'it should prefer the tool part\'s message, then the live assistant message'
  )

  // Lifting an image out of a tool result already knows the message: use it
  // rather than falling back to whichever assistant message is current.
  const extract = source.slice(source.indexOf('private extractToolResultImages('))
  assert.ok(
    /emitImagePart\(binding, tool, stored, typeof part\.messageID/.test(extract),
    'a lifted image should be anchored to its own tool part'
  )
})

test('a new run does not hang an image off the turn before it', () => {
  // The anchor is only meaningful while the run that set it is live. Carrying
  // it into the next run would attach a fresh image to a turn already drawn.
  const status = source.slice(source.indexOf("if (eventType === 'session.status')"))
  assert.ok(
    /status === 'busy'\) binding\.lastAssistantMessageId = undefined/.test(status),
    'a run going busy should clear the remembered message'
  )
})

test('the same image reported twice is shown once, and two images stay two', () => {
  // The renderer replaces a part carrying an id it already holds in that
  // message and appends anything else, so a random id per emission turned one
  // re-reported screenshot into a second picture. Naming the part after the
  // stored image makes the identity the picture itself.
  const body = source.slice(source.indexOf('private emitImagePart('))
  assert.ok(
    !/id:\s*`tool-image-\$\{randomUUID\(\)\}`/.test(body),
    'an image part must not take a fresh id on every emission'
  )
  assert.ok(
    body.includes('id: `tool-image-${stored.url}`'),
    'the part id should follow the stored image, which is unique per written image'
  )
})
