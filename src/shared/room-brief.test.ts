import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Application code uses bundler resolution.
import { HANDOVER_PROMPT, assistantBrief, briefForRole } from './room-brief.ts'

test('every participant is told its own name, so a message can say who it is from', () => {
  const brief = briefForRole({ id: 'builder', label: 'Builder' })
  assert.match(brief, /Builder/)
})

test('the reviewer is told it did not write the code and is not here to approve it', () => {
  // The whole reason a fresh reviewer is believed. Without being told, it read
  // as a second builder agreeing with the first.
  const brief = briefForRole({ id: 'reviewer', label: 'Reviewer' })
  assert.match(brief, /did not write this code/)
  assert.match(brief, /not here to approve/)
})

test('the reviewer is told why it does not get the builder\'s conversation', () => {
  // Otherwise a capable agent asks for it, and an agent that is given it can be
  // talked into agreeing by the account of the work rather than the work.
  const brief = briefForRole({ id: 'reviewer', label: 'Reviewer' })
  assert.match(brief, /account of itself/)
})

test('the builder is told a fresh agent will check it against the plan', () => {
  // The user trusts an agent that names where it went off plan. It cannot do
  // that if it does not know anyone is comparing the two.
  const brief = briefForRole({ id: 'builder', label: 'Builder' })
  assert.match(brief, /review your work against the plan/)
  assert.match(brief, /why/)
})

test('every participant is told job notes are the only thing that survives it', () => {
  // Nothing else carries: another agent never reads this conversation. An
  // agent that does not know that leaves the next one with nothing.
  for (const id of ['researcher', 'planner', 'builder', 'reviewer', 'releaser', 'boss']) {
    assert.match(briefForRole({ id, label: id }), /job notes/i, `${id} is told about notes`)
  }
})

test('every participant is told it speaks only when addressed', () => {
  // A room where agents answer each other is the noise the whole design avoids.
  const brief = briefForRole({ id: 'planner', label: 'Planner' })
  assert.match(brief, /only when the user addresses you/)
  assert.match(brief, /never reply to another agent/)
})

test('a role the user invented still gets the shared part', () => {
  // Role names are the user's. Starting an agent with nothing at all because
  // its name is unfamiliar is worse than telling it how a room works.
  const brief = briefForRole({ id: 'designer', label: 'Designer' })
  assert.match(brief, /Designer/)
  assert.match(brief, /job notes/i)
})

test('BOSS in a room is told to quote rather than summarise', () => {
  // Its own instructions used to reach only the standing conversation, so the
  // copy inside a room was a blank agent under the same name.
  const brief = briefForRole({ id: 'boss', label: 'BOSS' })
  assert.match(brief, /word for word/)
  assert.match(brief, /never write code/i)
})

test('the user\'s own instruction comes last, so it outranks the default', () => {
  const brief = briefForRole({ id: 'builder', label: 'Builder', instruction: 'Always run the linter.' })
  assert.match(brief, /Always run the linter\.$/)
})

test('an empty instruction adds nothing', () => {
  const brief = briefForRole({ id: 'builder', label: 'Builder', instruction: '   ' })
  assert.doesNotMatch(brief, /\n\n\n/)
})

test('the handover says nothing about the task', () => {
  // The arriving agent already holds its brief, the notes, and the diff. A
  // second, shorter version of its instructions could disagree with the first.
  assert.doesNotMatch(HANDOVER_PROMPT, /review|build|plan|research/i)
})

test('every participant is told how to write a card', () => {
  // A reviewer reporting where the work went off plan, and a builder asking
  // whether to go on, are the moments most worth setting apart. Neither could
  // write a card: the format reached only the standing assistant.
  for (const id of ['researcher', 'planner', 'builder', 'reviewer', 'boss']) {
    assert.match(briefForRole({ id, label: id }), /```boss-card/, `${id} can write a card`)
  }
})

test('the standing assistant is not told about a room it is not in', () => {
  // Its conversation is not a room. Telling it to speak only when addressed,
  // and never to reply to another agent, would describe a place it is not in.
  const brief = assistantBrief()
  assert.doesNotMatch(brief, /only when the user addresses you/)
  assert.doesNotMatch(brief, /never reply to another agent/)
})

test('the standing assistant is told what it is for', () => {
  const brief = assistantBrief()
  assert.match(brief, /never write code yourself/i)
  assert.match(brief, /word for word/)
  assert.match(brief, /```boss-card/, 'and how to write a card')
})

test('the assistant is named in the words the user gave it', () => {
  assert.match(assistantBrief('Chief'), /You are Chief, this user's standing assistant/)
})

test('the assistant is told the app carries its own name', () => {
  // The tools around it are named after the app. Without this line an agent
  // reads those names, decides BOSS is the system it talks to rather than
  // itself, and answers "I am not BOSS" when the user asks directly.
  for (const brief of [assistantBrief(), briefForRole({ id: 'boss', label: 'BOSS' })]) {
    assert.match(brief, /also called BOSS/)
    assert.match(brief, /the answer is yes/)
  }
})

test('the assistant is named the same way throughout when renamed', () => {
  // A brief that says "you are Chief" and then "you are BOSS" is the same
  // confusion in reverse.
  const brief = assistantBrief('Chief')
  assert.match(brief, /also called Chief/)
  assert.doesNotMatch(brief, /BOSS/)
})
