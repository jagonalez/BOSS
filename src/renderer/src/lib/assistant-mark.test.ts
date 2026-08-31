import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The mark that makes a thread the standing assistant.
 *
 *  Read from the source rather than by calling the function, because the
 *  function reaches the app store, the backend, and the team — none of which
 *  exist in a test. What matters here is a wiring rule, and wiring is visible
 *  in the text. */
function actions(): string {
  return readFileSync(join(import.meta.dirname, 'actions.ts'), 'utf8')
}

test('the assistant is marked every time it is opened, not only when created', () => {
  // Marked once at birth, a thread that lost the mark never got it back.
  // Deleting the chats cleared it; the app then found the thread again and
  // handed it back unmarked. BOSS ran with no standing instructions at all, so
  // asked who it was it answered "Claude" — correctly, because nothing had
  // told it otherwise.
  const source = actions()
  const body = source.slice(source.indexOf('async function startAssistantSession'))
  const returns = body.slice(0, body.indexOf('\n}\n')).match(/return [^\n]+/g) ?? []
  const handBack = returns.filter(
    (line) => !line.includes('adoptAssistant') && !line.includes('marked')
  )
  assert.deepEqual(handBack, [], 'every path that hands back a thread marks it first')
  assert.ok(returns.length >= 3, 'the reuse paths are still there to check')
})

test('a failed mark does not stop the conversation', () => {
  // Reach across projects is what the mark grants. Without it the assistant
  // still answers inside its own project, which is far better than refusing to
  // open at all.
  assert.match(actions(), /markAssistant\([^)]*\)\.catch/)
})
