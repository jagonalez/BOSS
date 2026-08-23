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

/** Threads used to carry their backend as a text pill beside the title. It was
 *  flex: 0 0 auto, so on a narrow tab it kept its full width while the title
 *  collapsed to an ellipsis: every tab read "Claude" or "OpenCode" and none of
 *  them said which thread it was. The pill is a mark now, and every backend
 *  needs one or its tabs fall back to a generic bubble. */
test('every backend has a mark for its tab', () => {
  // Read as source rather than imported: the test runner strips types but
  // cannot load .tsx, and the neighbouring tests already assert this way.
  const source = readFileSync(join(import.meta.dirname, '..', 'components', 'icons.tsx'), 'utf8')
  const marks = source.slice(source.indexOf('export const BACKEND_MARKS'))

  for (const id of BACKEND_IDS) {
    assert.match(marks, new RegExp(`\\b${id}:`), `${id} needs a mark`)
  }
})

/** The marks are the real brand paths, taken from published icon sets rather
 *  than drawn by hand. A first attempt approximated them and every mark read
 *  as a smudge at tab size: Claude came out as a plain letter A and OpenCode
 *  as a generic terminal box that collided with the terminal tabs. */
test('the backend marks credit where their paths came from', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'components', 'icons.tsx'), 'utf8')
  const marks = source.slice(source.indexOf('/** Backend marks.'))

  assert.match(marks, /simple-icons/, 'the Anthropic path is credited')
  assert.match(marks, /lobe-icons/, 'the OpenAI and OpenCode paths are credited')
})

test('the tab strip does not put the backend name beside the title', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'components', 'Workspace.tsx'), 'utf8')
  const label = source.slice(source.indexOf('function TabLabel'), source.indexOf('function NewThreadButtons'))

  assert.ok(!label.includes('<BackendBadge'), 'the tab shows the backend as a mark, not as a text badge')
  assert.ok(label.includes('tabMark('), 'the tab icon is the backend mark')
})

test('a thread row names its backend with a mark, not a word', () => {
  // The tabs learned this first: "OpenCode" spelled out cost about 55px of a 92px tab. A sidebar
  // row has the same problem — the width goes to the title, which is the part being scanned for.
  const source = readFileSync(join(import.meta.dirname, '..', 'components', 'Sidebar.tsx'), 'utf8')
  const row = source.slice(source.indexOf('function SessionRow'), source.indexOf('const RESOURCE_LABELS'))

  assert.ok(row.includes('BACKEND_MARKS['), 'the row should resolve a backend mark')
  assert.ok(!/>\s*\{backend\}\s*</.test(row), 'the row should not print the backend as its own word')
})
