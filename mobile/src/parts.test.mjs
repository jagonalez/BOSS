/**
 * Message-part reading. Pure logic, so it is checked directly rather than
 * through a rendered screen.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { attentionLabel, blocks, projectLabel, sortThreads, summarise, textOf, toolKind, toolSummary } from './parts.ts'

test('a tool is classified the way the desktop classifies it', () => {
  assert.equal(toolKind({ state: { input: { command: 'ls -la' } } }), 'command')
  assert.equal(toolKind({ state: { input: { url: 'https://example.com' } } }), 'page')
  assert.equal(toolKind({ state: { input: { file_path: '/a/b.ts' } } }), 'read')
  assert.equal(toolKind({ state: { input: { file_path: '/a/b.ts', content: 'x' } } }), 'edit')
  assert.equal(toolKind({ state: { input: { filePath: '/a/b.ts', edits: [] } } }), 'edit')
  assert.equal(toolKind({ state: { input: {} } }), 'other')
})

test('a tool summarises to the thing worth reading on a phone', () => {
  assert.equal(toolSummary({ state: { input: { command: 'npm test' } } }), 'npm test')
  assert.equal(toolSummary({ state: { input: { url: 'https://x.dev/a' } } }), 'https://x.dev/a')
  // A full path does not fit, so keep the end of it.
  assert.equal(toolSummary({ state: { input: { file_path: '/very/long/path/to/file.ts' } } }), 'to/file.ts')
  assert.equal(toolSummary({ tool: 'grep', state: {} }), 'grep')
})

test('a step summary counts what happened', () => {
  const tools = [
    { state: { input: { command: 'ls' } } },
    { state: { input: { command: 'pwd' } } },
    { state: { input: { file_path: '/a.ts' } } },
    { state: { input: { file_path: '/b.ts', content: 'x' } } }
  ]
  assert.equal(summarise(tools), '2 commands · read 1 file · edited 1 file')
  assert.equal(summarise([]), '')
})

test('text is joined across parts and ignores tools', () => {
  const message = {
    parts: [
      { type: 'text', text: 'first' },
      { type: 'tool', state: { input: { command: 'ls' } } },
      { type: 'text', text: 'second' }
    ]
  }
  assert.equal(textOf(message), 'first\nsecond')
})

test('fenced code is separated from prose', () => {
  const result = blocks('before\n```ts\nconst a = 1\n```\nafter')
  assert.deepEqual(result, [
    { kind: 'text', content: 'before' },
    { kind: 'code', content: 'const a = 1', language: 'ts' },
    { kind: 'text', content: 'after' }
  ])
})

test('a fence still being written renders as code rather than flickering', () => {
  // Every streaming reply looks like this mid-write.
  const result = blocks('here is the fix\n```js\nconst x = 1')
  assert.equal(result.length, 2)
  assert.equal(result[1].kind, 'code')
  assert.equal(result[1].content, 'const x = 1')
})

test('prose with no code is one block', () => {
  assert.deepEqual(blocks('just words'), [{ kind: 'text', content: 'just words' }])
})

test('a fence with no language is still code', () => {
  const result = blocks('```\nplain\n```')
  assert.deepEqual(result, [{ kind: 'code', content: 'plain', language: undefined }])
})

test('threads needing a decision sort above everything else', () => {
  const rows = [
    { threadId: 'idle', updatedAt: 500 },
    { threadId: 'running', running: true, updatedAt: 100 },
    { threadId: 'asks', attention: { kind: 'permission' }, updatedAt: 1 },
    { threadId: 'failed', attention: { kind: 'error' }, updatedAt: 400 },
    { threadId: 'done', attention: { kind: 'completed' }, updatedAt: 300 }
  ]
  // A permission prompt outranks a thread that updated far more recently,
  // because the phone list is read from the top and rarely scrolled.
  assert.deepEqual(sortThreads(rows).map((t) => t.threadId), ['asks', 'failed', 'running', 'done', 'idle'])
})

test('threads of equal rank fall back to most recent', () => {
  const rows = [
    { threadId: 'older', updatedAt: 100 },
    { threadId: 'newer', updatedAt: 900 }
  ]
  assert.deepEqual(sortThreads(rows).map((t) => t.threadId), ['newer', 'older'])
})

test('sorting does not mutate the array it was given', () => {
  const rows = [{ threadId: 'a', updatedAt: 1 }, { threadId: 'b', attention: { kind: 'error' } }]
  sortThreads(rows)
  assert.equal(rows[0].threadId, 'a')
})

test('a row says which project and branch it works in', () => {
  assert.equal(projectLabel({ threadId: '1', projectPath: '/Users/j/dev/BOSS', worktreeBranch: 'fix-x' }), 'BOSS · fix-x')
  assert.equal(projectLabel({ threadId: '1', projectPath: '/Users/j/dev/BOSS' }), 'BOSS')
  assert.equal(projectLabel({ threadId: '1' }), '')
})

test('every attention kind has wording a glance can read', () => {
  for (const kind of ['permission', 'question', 'completed', 'error', 'interrupted']) {
    assert.match(attentionLabel(kind), /^[A-Z]/)
  }
})
