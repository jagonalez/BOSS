/**
 * Drive real Claude Agent SDK runs the way the backend does.
 *
 * The unit tests check the pieces BOSS owns — how a request is shaped, how a
 * decision is built. They cannot prove the SDK accepts the options BOSS passes,
 * or that a turn produces the messages the backend reads.
 *
 * The image case is here because it failed silently. Anthropic documents
 * single-message input as the limited mode — no image blocks, no queued
 * messages, no interruption — and a content-block array sent that way ends the
 * turn with no assistant message, no result and no error. Nothing in the type
 * system or the unit tests catches that, so it has to be run.
 *
 * Costs a few small API calls against whatever subscription the CLI is logged
 * in as.
 *
 * Usage: node scripts/probe-claude-sdk.mjs
 */
import { query } from '@anthropic-ai/claude-agent-sdk'

// A 1x1 red PNG, small enough to inline.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const results = []
function record(name, ok, detail) {
  results.push({ name, ok })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

/** The same shape the backend sends: one user message through a generator. */
async function* once(content) {
  yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null }
}

function run(content, extra = {}) {
  return query({
    prompt: once(content),
    options: { cwd: process.cwd(), permissionMode: 'default', includePartialMessages: true, ...extra }
  })
}

async function collect(session) {
  const seen = new Set()
  let text = ''
  let subtype
  for await (const message of session) {
    seen.add(message.type)
    if (message.type === 'assistant') {
      for (const block of message.message?.content ?? []) {
        if (block.type === 'text') text += block.text
      }
    } else if (message.type === 'result') {
      subtype = message.subtype
    }
  }
  return { seen, text: text.trim(), subtype }
}

console.log('real Claude turns:\n')

{
  const { seen, text, subtype } = await collect(run('Reply with exactly: BOSS probe ok'))
  record(
    'a text turn streams and completes',
    seen.has('assistant') && subtype === 'success' && text.length > 0,
    `${[...seen].sort().join(', ')} → ${JSON.stringify(text)}`
  )
}

{
  // The regression that started this. A content-block array in single-message
  // mode produced no messages at all.
  const { text, subtype } = await collect(run([
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
    { type: 'text', text: 'Reply with exactly: SAW IMAGE' }
  ]))
  record(
    'an attached image reaches the model',
    subtype === 'success' && text.length > 0,
    text ? JSON.stringify(text) : 'no assistant message — the turn died silently'
  )
}

{
  // Stop & redirect depends on this. Documented as streaming-only.
  const session = run('Count slowly from 1 to 500, one number per line.')
  let interrupted = false
  try {
    for await (const message of session) {
      if (message.type === 'assistant' && !interrupted) {
        interrupted = true
        await session.interrupt()
      }
    }
  } catch {
    // An interrupted run may end by rejecting; that is the stop, not a failure.
  }
  record('a run can be interrupted mid-turn', interrupted, interrupted ? 'interrupt() accepted' : 'never reached an assistant message')
}

const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
