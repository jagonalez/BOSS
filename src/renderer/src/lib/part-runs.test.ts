import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Application code uses bundler resolution.
import { fileChanges, groupPartRuns, segmentTurn, toolKind } from './part-runs.ts'
import type { Part } from '../../../shared/opencode.ts'

const tool = (id: string, input: Record<string, unknown>): Part => ({
  id,
  type: 'tool',
  sessionID: 's',
  messageID: 'm',
  state: { status: 'completed', input }
}) as Part

const command = (id: string): Part => tool(id, { command: 'ls' })
const edit = (id: string): Part => tool(id, { file_path: '/src/a.ts', new_string: 'after', old_string: 'before' })
const read = (id: string): Part => tool(id, { file_path: '/src/a.ts' })
const page = (id: string): Part => tool(id, { url: 'https://example.com' })
const reasoning = (id: string, text: string): Part => ({
  id, type: 'reasoning', sessionID: 's', messageID: 'm', text
}) as Part
const text = (id: string, body: string): Part => ({
  id, type: 'text', sessionID: 's', messageID: 'm', text: body
}) as Part
const image = (id: string): Part => ({
  id,
  type: 'file',
  sessionID: 's',
  messageID: 'm',
  state: { mime: 'image/png', url: 'boss-image://shot.png', name: 'shot.png' }
}) as Part

test('neighbouring reads become a run', () => {
  const runs = groupPartRuns([read('1'), read('2'), read('3')])
  assert.equal(runs.length, 1)
  assert.equal(runs[0].kind, 'read')
  assert.equal(runs[0].parts.length, 3)
})

test('a Codex fileChange is an edit, not an untyped step', () => {
  // Codex sends an array of {path, kind, diff} where the others send one object
  // with a file_path. Read as an object it has no path at all, so the card said
  // "1 step" and offered no file name, no diff stat and no way into Review.
  const part = {
    id: 'f1',
    type: 'tool',
    sessionID: 's',
    messageID: 'm',
    state: {
      status: 'completed',
      tool: 'fileChange',
      input: [
        { path: '/src/a.ts', kind: 'modified', diff: '@@ -1,2 +1,2 @@\n-old\n+new\n' },
        { path: '/src/b.ts', kind: 'added', diff: '@@ -0,0 +1 @@\n+added\n' }
      ]
    }
  } as unknown as Part
  assert.equal(toolKind(part), 'edit')
  assert.deepEqual(fileChanges(part).map((c) => c.path), ['/src/a.ts', '/src/b.ts'])
})

test('a Codex edit never folds into a run', () => {
  const one = (id: string): Part => ({
    id, type: 'tool', sessionID: 's', messageID: 'm',
    state: { status: 'completed', input: [{ path: '/a.ts', diff: '+x' }] }
  }) as unknown as Part
  assert.equal(groupPartRuns([one('1'), one('2')]).length, 2)
})

test('a non-Codex input is not mistaken for a change list', () => {
  assert.deepEqual(fileChanges(read('r')), [])
  assert.deepEqual(fileChanges(command('c')), [])
})

test('a path alone is a read; a payload makes it an edit', () => {
  // Read, Edit and Write all take a file_path. Only the payload says which.
  assert.equal(toolKind(read('1')), 'read')
  assert.equal(toolKind(edit('2')), 'edit')
  assert.equal(toolKind(tool('3', { file_path: '/a.ts', content: 'new file' })), 'edit')
})

test('commands never fold into each other', () => {
  // A command is what you audit or undo, so it keeps its own row.
  const runs = groupPartRuns([command('1'), command('2'), command('3')])
  assert.equal(runs.length, 3)
  assert.deepEqual(runs.map((run) => run.kind), ['command', 'command', 'command'])
})

test('edits never fold into each other', () => {
  const runs = groupPartRuns([edit('1'), edit('2')])
  assert.equal(runs.length, 2, 'an edit must stay individually addressable')
})

test('a different kind starts a new run', () => {
  const runs = groupPartRuns([command('1'), edit('2'), command('3')])
  assert.deepEqual(runs.map((run) => run.kind), ['command', 'edit', 'command'])
  assert.deepEqual(runs.map((run) => run.parts.length), [1, 1, 1])
})

test('reasoning is never folded into a run', () => {
  // It explains the calls around it. Hiding it behind a count would bury the
  // one part written to be read.
  const runs = groupPartRuns([reasoning('1', 'first'), reasoning('2', 'second')])
  assert.equal(runs.length, 2)
  assert.deepEqual(runs.map((run) => run.kind), ['reasoning', 'reasoning'])
})

test('reasoning between calls breaks the run around it', () => {
  const runs = groupPartRuns([read('1'), reasoning('2', 'why'), read('3')])
  assert.deepEqual(runs.map((run) => run.kind), ['read', 'reasoning', 'read'])
})

test('empty reasoning and other part types are left out', () => {
  const runs = groupPartRuns([text('t', 'hello'), reasoning('1', '   '), command('2')])
  assert.deepEqual(runs.map((run) => run.kind), ['command'])
})

test('each part keeps its position in the message', () => {
  // The index disambiguates keys: Claude emits tool_use and tool_result as
  // separate parts sharing one id.
  const runs = groupPartRuns([reasoning('a', 'why'), read('b'), read('b')])
  assert.deepEqual(runs[1].parts.map((entry) => entry.index), [1, 2])
})

test('a long sweep of reads collapses to one row', () => {
  // The reported case: forty-five calls in one flat wall. Reads are the kind
  // that folds, so this is where the collapse earns its keep.
  const parts = Array.from({ length: 45 }, (_, index) => read(String(index)))
  const runs = groupPartRuns(parts)
  assert.equal(runs.length, 1, '45 reads should be one run, not 45 rows')
  assert.equal(runs[0].parts.length, 45)
})

test('a turn splits into narrative and the work between it', () => {
  // The bug this fixes: every call rendered in one card, all prose below it, so
  // reading a call meant scrolling past the whole card.
  const segments = segmentTurn([
    text('t1', 'First I will look.'),
    read('r1'),
    read('r2'),
    text('t2', 'Now I will change it.'),
    edit('e1')
  ])
  assert.deepEqual(segments.map((s) => s.type), ['narrative', 'steps', 'narrative', 'steps'])
  assert.equal(segments[1].type === 'steps' && segments[1].parts.length, 2)
  assert.equal(segments[3].type === 'steps' && segments[3].parts.length, 1)
})

test('consecutive calls stay in one segment', () => {
  const segments = segmentTurn([command('c1'), reasoning('r', 'why'), edit('e1')])
  assert.equal(segments.length, 1)
  assert.equal(segments[0].type === 'steps' && segments[0].parts.length, 3)
})

test('an image is narrative, not a step', () => {
  // Behind a collapsed card it is a screenshot nobody sees.
  const segments = segmentTurn([read('r1'), image('i1'), read('r2')])
  assert.deepEqual(segments.map((s) => s.type), ['steps', 'narrative', 'steps'])
})

test('empty text and unrenderable parts open no segment', () => {
  const segments = segmentTurn([text('t1', '   '), reasoning('r1', ''), page('p1')])
  assert.deepEqual(segments.map((s) => s.type), ['steps'])
  assert.equal(segments[0].type === 'steps' && segments[0].parts.length, 1)
})

test('a turn with no parts yields no segments', () => {
  // The state between sending a prompt and the first message arriving. The
  // renderer builds a turn for it, so this must not throw.
  assert.deepEqual(segmentTurn([]), [])
})

test('a turn with no work is all narrative', () => {
  const segments = segmentTurn([text('t1', 'Just an answer.')])
  assert.deepEqual(segments.map((s) => s.type), ['narrative'])
})
