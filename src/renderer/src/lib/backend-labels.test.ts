import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BACKEND_IDS } from '../../../shared/backend.ts'
import { BACKEND_SHORT_LABELS } from './backend-labels.ts'

test('every backend has a short label', () => {
  for (const id of BACKEND_IDS) {
    assert.ok(BACKEND_SHORT_LABELS[id], `${id} needs a label`)
  }
})

/** Cards that name the agent must name the one that actually asked. The
 *  question card said "opencode is asking you" for every backend, so a Claude
 *  thread asking a question blamed OpenCode. Claude is in fact the only
 *  backend that emits question.asked, so the label was always wrong. */
test('the question card names the backend that asked, not a fixed one', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'components', 'ChatView.tsx'), 'utf8')

  const card = source.slice(source.indexOf('function QuestionCard'), source.indexOf('function Composer'))
  assert.ok(card.length > 0, 'QuestionCard must be found')

  assert.ok(
    card.includes('BACKEND_SHORT_LABELS[backendId]'),
    'the title must read the label from the asking backend'
  )
  assert.ok(!/opencode is asking/i.test(card), 'the title must not hardcode a backend name')

  // The card renders per session, so the id has to be passed in rather than
  // guessed from the default engine.
  assert.ok(
    source.includes('<QuestionCard question={question} backendId={backendId} />'),
    'the render site must pass the session backend'
  )
})

/** One label map. A second inline copy drifted from this one before. */
test('no component inlines its own backend label map', () => {
  const dir = join(import.meta.dirname, '..', 'components')
  for (const file of ['Workspace.tsx', 'ChatView.tsx']) {
    const source = readFileSync(join(dir, file), 'utf8')
    assert.ok(
      !/\{\s*opencode:\s*'OpenCode'/.test(source),
      `${file} must use BACKEND_SHORT_LABELS instead of its own map`
    )
  }
})
