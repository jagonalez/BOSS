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
    guard < block.indexOf('settleBusy'),
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
    body.indexOf('settleBusy') < body.indexOf('deliverNextFollowUp'),
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
    suspend < block.indexOf('settleBusy'),
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

test('BOSS-owned Codex threads consult stored history before starting a native read', () => {
  const start = source.indexOf('async messagesList(threadId: string')
  assert.ok(start > 0, 'expected messagesList')
  const body = source.slice(start, source.indexOf('\n  async ', start + 10))
  const storedHistory = body.indexOf("binding.backendId === 'codex'")
  const nativeRead = body.indexOf('ensureStarted')
  assert.ok(storedHistory > 0, 'expected the stored-history guard')
  assert.ok(nativeRead > storedHistory, 'the guard must run before a native backend history request')
  assert.ok(
    body.includes('return this.transcripts.messages(threadId, limit)'),
    'the safe path must return the sanitized TranscriptStore projection'
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

test('an image part joins the tool message that produced it', () => {
  // groupTurns closes a turn only on a user message, so an assistant message
  // that nothing else shares never ends one: an image given a fresh messageID
  // stayed in the open turn and was drawn again under every later reply until
  // the user spoke. That is the repeated-screenshot report. The image has to
  // land in the message that produced it.
  const start = source.indexOf('private toolImagePart(')
  assert.ok(start > 0, 'expected a toolImagePart method')
  const body = source.slice(start, source.indexOf('\n  }', start))
  assert.ok(
    !body.includes('assistant-tool-image-'),
    'emitImagePart must not mint a message id as its default'
  )
  assert.ok(body.includes('messageID: messageId'), 'the part should take the tool message owner')
  assert.ok(body.includes('messageId: string'), 'an owner should be required before an image can be emitted')

  // Lifting an image out of a tool result already knows the message: use it
  // rather than falling back to whichever assistant message is current.
  const extract = source.slice(source.indexOf('private extractToolResultImages('))
  assert.ok(
    /toolImagePart\(binding, context\.tool, stored, part\.messageID, part\.id, blockIndex\)/.test(extract),
    'a lifted image should be anchored to its own tool part'
  )
})

test('the same image reported twice is shown once, and two images stay two', () => {
  // The renderer replaces a part carrying an id it already holds in that
  // message and appends anything else, so a random id per emission turned one
  // re-reported screenshot into a second picture. Naming the part after its
  // producing tool block makes live and history agree without collapsing two
  // equal images at different positions.
  const body = source.slice(source.indexOf('private toolImagePart('), source.indexOf('private emitImagePart('))
  assert.ok(
    !/id:\s*`tool-image-\$\{randomUUID\(\)\}`/.test(body),
    'an image part must not take a fresh id on every emission'
  )
  assert.ok(
    body.includes('id: `tool-image-${toolPartId}-${blockIndex}`'),
    'the part id should be stable across live/history while retaining each block position'
  )
})

test('native history extracts tool images through the same path as live events', () => {
  const history = source.slice(source.indexOf('async messagesList('), source.indexOf('async sendMessage('))
  assert.ok(history.includes('this.extractToolResultImages(binding,'), 'history must strip and store raw image blocks')
  assert.ok(history.includes('return [...extracted.images, extracted.part]'), 'images should retain live event ordering before the tool output')

  const live = source.slice(source.indexOf('private forwardEvent('), source.indexOf('private async sessionCreateInScope('))
  assert.ok(live.includes('for (const image of extracted.images) this.emitImagePart(binding, image)'))
})

test('computer inspection images are stripped before the transcript stores them', () => {
  const body = source.slice(
    source.indexOf('private extractToolResultImages('),
    source.indexOf('private emitImagePart(')
  )
  const visibility = body.indexOf('shouldSurfaceToolImage(context.tool, context.input)')
  const write = body.indexOf('this.images?.write(')
  assert.ok(visibility > 0, 'the original tool input should decide whether its image is user-facing')
  assert.ok(visibility < write, 'an internal screenshot must be rejected before it is written to the transcript image store')
  assert.ok(body.includes('this.toolResultContexts.get(contextKey)'), 'a split completion must recover its start-event context')
  assert.ok(body.includes('this.toolResultContexts.delete(contextKey)'), 'completed calls must release remembered context')
  assert.ok(body.includes('[Screenshot inspected internally.]'))
})

test('pinning is recorded on the binding and persisted, like archiving', () => {
  // A pin that lived in one window's storage would put the thread at the top
  // of that window's list and nowhere else — the phone and a second window
  // would disagree about what is pinned. The handler must write the field on
  // the binding (which save() serializes wholesale) before anything else.
  const start = source.indexOf("case 'thread.pin':")
  assert.ok(start > 0, 'expected a thread.pin case in handle()')
  const body = source.slice(start, source.indexOf('\n      }', start))
  assert.ok(
    /binding\.pinned = request\.pinned/.test(body),
    'the pin must land on the binding, which is what persists'
  )
  const save = body.indexOf('this.save()')
  assert.ok(save > 0, 'the pin must be saved')
  assert.ok(
    save < body.indexOf('type: \'session.updated\''),
    'the announcement must come after the save, so late listeners read stored state'
  )
})

test('a session carries its pin to every client', () => {
  // session() is the only shape the renderer and the mobile page ever see.
  // Dropping the field there would leave the sidebar sorting from nothing.
  const start = source.indexOf('private session(binding: ThreadBinding')
  const body = source.slice(start, source.indexOf('\n  }', start))
  assert.ok(
    /pinned: binding\.pinned === true/.test(body),
    'session() must project binding.pinned'
  )
})

test('thread.usage reports recorded metrics plus the thread budget', () => {
  // The composer meter reads this. It must surface exactly what the transcript
  // store recorded — never invent numbers — and attach the budget only when a
  // policy actually set one.
  const start = source.indexOf("case 'thread.usage':")
  assert.ok(start > 0, 'expected a thread.usage case in handle()')
  const body = source.slice(start, source.indexOf('\n      }', start))
  assert.ok(
    /transcripts\?\.usage\(binding\.id\)/.test(body),
    'usage must come from the transcript store'
  )
  assert.ok(
    /budget: binding\.policy\?\.budget/.test(body),
    'the budget must be the policy\'s own, absent when there is none'
  )
})

test('a cloned thread continues in the source checkout, not the open project', () => {
  // "Continue in <backend>" used to call sessionCreate, which resolves the
  // app's *current* scope rather than the source thread's. A clone of a
  // worktree thread therefore landed on the project root with no worktree, so
  // it silently lost the branch it was meant to be continuing — and with it the
  // pull request every review surface looks up from the checkout.
  const start = source.indexOf('async clone(threadId: string')
  assert.ok(start > 0, 'expected a clone method')
  const body = source.slice(start, source.indexOf('\n  }', start))
  assert.ok(
    /executionPath: source\.executionPath/.test(body),
    'a clone must execute where the source thread was executing'
  )
  assert.ok(
    /source\.worktree\?\.status === 'active' \? source\.worktree : undefined/.test(body),
    'a clone must inherit a live worktree, and never a reaped one'
  )
})

test('a handover starts the next agent instead of only aiming the composer at it', () => {
  // Joining alone left the shape waiting: the reviewer arrived, the chip
  // pointed at it, and nothing happened until the user typed. A shape that has
  // to be driven by hand at every step is not a shape running.
  const start = source.indexOf('private async handOver(threadId: string')
  assert.ok(start > 0, 'expected a handOver method')
  const body = source.slice(start, source.indexOf('\n  }', start))
  assert.ok(/this\.rooms\.join\(room, next\)/.test(body), 'the next role must join')
  assert.ok(
    /this\.sendMessage\(room, \[\{ type: 'text', text: HANDOVER_PROMPT \}\], \{ recipient: next \}\)/.test(body),
    'the next role must be sent its first message, through the room'
  )
})

test('the handover runs only after the room releases its own claim', () => {
  // It is started by sending into the room, and a room refuses a message while
  // it still believes it is busy. Raised any earlier, every handover was
  // refused by the very run that caused it.
  const start = source.indexOf('private settleBusy(threadId: string)')
  assert.ok(start > 0, 'expected a settleBusy method')
  const body = source.slice(start, source.indexOf('\n  }\n', start))
  const release = body.indexOf('!this.busyThreads.delete(parent)')
  assert.ok(release > 0, 'expected the room to be released')
  // Two calls, and both must sit after the room lets go. The first belongs to
  // the branch where there is no room to release; the second runs once there
  // is and it has been released. A third, raised before either, would be
  // refused by the very run that caused it.
  const calls = [...body.matchAll(/this\.handOver\(threadId\)/g)].map((match) => match.index ?? -1)
  assert.equal(calls.length, 2, 'exactly two handover calls: one per branch')
  assert.ok(calls.every((at) => at > release), 'no handover may run before the room lets go')
})

test('a joining participant is told who it is, what was agreed, and what changed', () => {
  // It used to receive the job notes and nothing else. A reviewer was never
  // told it reviews, and never saw the diff it was brought in to check — so it
  // read as a second builder agreeing with the first.
  const start = source.indexOf('private async sendToParticipant(')
  assert.ok(start > 0, 'expected a sendToParticipant method')
  const body = source.slice(start, source.indexOf('\n  }\n', start))
  const first = body.indexOf('if (missed.first)')
  assert.ok(first > 0, 'the brief is sent once, on the first message only')
  assert.ok(/this\.roleBrief\(recipient\)/.test(body), 'it must be told which role it is')
  assert.ok(/\[JOB NOTES\]/.test(body), 'it must be told what the job agreed')
  assert.ok(/this\.roomDiff\(roomThreadId\)/.test(body), 'it must be told what changed on disk')
})

test('the diff a joining agent reads comes from the checkout, not from a backend', () => {
  // Two of the backends report no diff at all, and a reviewer handed the
  // builder's own account of what it changed is exactly the reviewer the user
  // said they do not trust. Every participant shares one checkout.
  const start = source.indexOf('private async roomDiff(')
  assert.ok(start > 0, 'expected a roomDiff method')
  const body = source.slice(start, source.indexOf('\n  }\n', start))
  assert.ok(/runCommand\('git'/.test(body), 'the working tree is the source of truth')
  assert.ok(!/diffGet/.test(body), 'a backend must not be asked what it changed')
  assert.ok(/ls-files', '--others'/.test(body), 'a new file is a change too')
})

test('a participant that finishes stops reading as working', () => {
  // It was set to 'working' when its run began and never set back, so the room
  // showed every agent that had ever spoken as still running. With a shape
  // handing work along, that was all of them at once.
  const start = source.indexOf('private async handOver(threadId: string')
  const body = source.slice(start, source.indexOf('\n  }', start))
  const cleared = body.indexOf("touch(room, finished, 'active')")
  assert.ok(cleared > 0, 'the finished participant must be marked reachable again')
  assert.ok(
    cleared < body.indexOf('nextAfter'),
    'clearing must come first, so a later failure cannot strand it as working'
  )
})

test('a broadcast reaches every participant, one at a time', () => {
  // The code that works out who a broadcast goes to existed, was tested, and
  // was called by nothing: sending to everyone quietly reached the thread's own
  // agent instead.
  const start = source.indexOf('private async broadcast(')
  assert.ok(start > 0, 'expected a broadcast method')
  const body = source.slice(start, source.indexOf('\n  }\n', start))
  assert.ok(/deliveryFor\(room, ROOM_EVERYONE\)/.test(body), 'it must ask who is in the room')
  assert.ok(/for \(const roleId of delivery\.roleIds\)/.test(body), 'each participant answers')
  assert.ok(
    /await this\.sendToParticipant\(/.test(body),
    'awaited in the loop, so two agents never stream into one list at once'
  )
})

test('a broadcast holds the room until every participant has answered', () => {
  // Released per agent, the room would look idle between them and a user
  // message could start a competing run halfway through the round.
  const start = source.indexOf('private async broadcast(')
  const body = source.slice(start, source.indexOf('\n  }\n', start))
  assert.ok(/} finally {/.test(body), 'the claim must come back however the round ends')
  const settles = [...body.matchAll(/this\.settleBusy\(threadId\)/g)]
  assert.ok(settles.length >= 1, 'the room is released at the end')
  assert.ok(
    /this\.busyThreads\.add\(threadId\)/.test(body),
    'a participant that fails releases the room on its way out; the round takes it back'
  )
})

test('a broadcast does not advance the shape', () => {
  // Otherwise asking everyone a question moves the work on: the builder answers,
  // its run ends, and the reviewer is pulled in as though the build were done.
  const start = source.indexOf('private async handOver(threadId: string')
  const body = source.slice(start, source.indexOf('\n  }', start))
  assert.ok(
    /this\.broadcasting\.has\(room\)/.test(body),
    'a handover must not fire while the room is answering a broadcast'
  )
})

test('an idle participant is retired before a message decides where to go', () => {
  // The rule was written and tested and never ran: nothing called it, so a
  // two-week-old session was resumed at its full cost and spoke confidently
  // about code that had moved.
  const start = source.indexOf('private async routeToParticipant(')
  const body = source.slice(start, source.indexOf('\n  }\n', start))
  const retire = body.indexOf('retireStale')
  assert.ok(retire > 0, 'stale participants must be retired')
  assert.ok(
    retire < body.indexOf('this.rooms.room(threadId)'),
    'retiring must come before the room is read, or the message routes to a session about to be dropped'
  )
})

test('a broadcast cannot strand the flag that suppresses handovers', () => {
  // Set outside the try, a failed room read left it on for ever, and that room
  // never handed work along again — a silent, permanent fault from one failed
  // read. Everything after the flag has to be inside the try.
  const start = source.indexOf('private async broadcast(')
  const body = source.slice(start, source.indexOf('\n  }\n', start))
  const flag = body.indexOf('this.broadcasting.add(threadId)')
  const opens = body.indexOf('try {')
  assert.ok(flag > 0 && opens > 0, 'expected a flag and a try')
  assert.ok(opens > flag, 'the flag is set first, so the try can always clear it')
  assert.ok(
    body.indexOf('await this.rooms?.room(threadId)') > opens,
    'nothing that can throw may sit between the flag and the try'
  )
  assert.ok(/this\.broadcasting\.delete\(threadId\)/.test(body.slice(body.indexOf('} finally {'))),
    'the flag is cleared in finally, whatever happened')
})

test('a broadcast waits for each agent to answer, not merely to start', () => {
  // A backend's send resolves when the turn is dispatched, not when the agent
  // has answered. Awaiting only the send fired every participant within
  // milliseconds and they all streamed into one list at once — exactly the
  // noise a room exists to prevent, hidden behind a loop that looked sequential.
  const start = source.indexOf('private async broadcast(')
  const body = source.slice(start, source.indexOf('\n  }\n', start))
  const registered = body.indexOf('this.runEnds(routed)')
  const sent = body.indexOf('this.sendToParticipant(')
  assert.ok(registered > 0, 'the round must wait on the run, not on the send')
  assert.ok(registered < sent, 'registered before the send, or a fast run finishes unheard')
  assert.ok(/if \(started\) await answered/.test(body), 'the next agent waits for this one')
  assert.ok(
    /else this\.forgetRunWaiters\(routed\)/.test(body),
    'a send that never started must not leave the round waiting for an answer'
  )
})

test('a participant finishing does not release a room that is mid-broadcast', () => {
  // The room belongs to the round, not to any one agent. Without this the
  // fastest agent released the room while the others were still writing, and a
  // follow-up could start a competing run into the same list.
  const start = source.indexOf('private settleBusy(threadId: string)')
  const body = source.slice(start, source.indexOf('\n  }\n', start))
  const guard = body.indexOf('this.broadcasting.has(parent)')
  assert.ok(guard > 0, 'a broadcast must hold the room across the whole round')
  assert.ok(
    guard < body.indexOf('this.busyThreads.delete(parent)'),
    'the guard must come before the room is released'
  )
})

test('waiting on a run cannot hang for ever', () => {
  // Every ordinary ending settles a run, but a backend that goes silent without
  // saying so would otherwise hold the round, and the room, indefinitely.
  const start = source.indexOf('private runEnds(threadId: string)')
  const body = source.slice(start, source.indexOf('\n  }', start))
  assert.ok(/BROADCAST_TURN_LIMIT_MS/.test(body), 'the wait must be capped')
  assert.ok(/clearTimeout\(limit\)/.test(body), 'a run that ends normally must not leave a timer')
})

test('a room\'s agent inherits its room\'s project rather than inventing one', () => {
  // Built from a path, a room with no project — an ordinary chat — turned the
  // folder its chats happen to run in into a project. It then appeared in the
  // sidebar as a project called "chats" that was always empty, because every
  // chat in it was also listed under Chats.
  const start = source.indexOf('async createParticipantThread(')
  const body = source.slice(start, source.indexOf('\n  }\n', start))
  assert.ok(/projectId: room\.projectId/.test(body), 'the room says which project this is')
  assert.ok(!/this\.scopeFor\(/.test(body), 'a scope must not be rebuilt from a folder path')
})

test('a room reads its own messages rather than asking a backend', () => {
  // A room holds what several agents said, and no single backend knows all of
  // it — each reports only its own half. Reading one returned its agent's
  // history and wrote that into the agent's hidden thread, so the room itself
  // came up empty however many messages it held.
  const start = source.indexOf('async messagesList(threadId: string')
  const body = source.slice(start, source.indexOf('\n  async ', start + 10))
  const guard = body.indexOf('this.hasParticipants(threadId)')
  assert.ok(guard > 0, 'a room must be recognised before any backend is asked')
  assert.ok(guard < body.indexOf('ensureStarted'), 'and before its history is fetched')
  assert.ok(guard < body.indexOf('reconcile'), 'and before anything is reconciled over it')
})
