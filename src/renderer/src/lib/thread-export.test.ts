import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Application code uses bundler resolution.
import { exportFileName, groupExportTurns, serializeThreadMarkdown } from './thread-export.ts'
import type { MessageWithParts, Part } from '../../../shared/opencode.ts'

let nextId = 1

function part(partial: Partial<Part> & { type: Part['type'] }): Part {
  return {
    id: `part-${nextId++}`,
    sessionID: 't1',
    messageID: 'm',
    ...partial
  }
}

function message(role: 'user' | 'assistant', parts: Part[], created = 1_700_000_000_000): MessageWithParts {
  const info = {
    id: `msg-${nextId++}`,
    sessionID: 't1',
    role,
    time: { created }
  }
  for (const item of parts) item.messageID = info.id
  return { info, parts }
}

test('renders the title header and alternating user/assistant sections', () => {
  const markdown = serializeThreadMarkdown([
    message('user', [part({ type: 'text', text: 'Fix the flaky test.' })]),
    message('assistant', [part({ type: 'text', text: 'The timer was never cleared. Patched it.' })])
  ], { title: 'Flaky timer' })
  assert.ok(markdown.startsWith('# Flaky timer\n\n'))
  assert.ok(markdown.includes('### User\n\nFix the flaky test.'))
  assert.ok(markdown.includes('### Assistant\n\nThe timer was never cleared. Patched it.'))
  assert.ok(
    markdown.indexOf('### User') < markdown.indexOf('### Assistant'),
    'the user speaks before the assistant replies'
  )
})

test('the header carries only the metadata that exists', () => {
  const bare = serializeThreadMarkdown([], {})
  assert.equal(bare, '# Untitled thread\n')
  const full = serializeThreadMarkdown([], {
    title: 'T',
    backendLabel: 'Claude Code',
    projectPath: '/repo',
    exportedAt: 0
  })
  assert.ok(full.includes('_Backend: Claude Code · Project: /repo · Exported: 1970-01-01T00:00:00.000Z_'))
})

test('reasoning parts are omitted entirely', () => {
  const markdown = serializeThreadMarkdown([
    message('assistant', [
      part({ type: 'reasoning', text: 'I should look at the timer module first.' }),
      part({ type: 'text', text: 'Done.' })
    ])
  ], { title: 'R' })
  assert.ok(!markdown.includes('I should look at the timer module'))
  assert.ok(markdown.includes('Done.'))
})

test('each tool step becomes one list line with its useful summary', () => {
  const markdown = serializeThreadMarkdown([
    message('assistant', [
      part({ type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'npm test -- --filter timer' } } }),
      part({ type: 'tool', tool: 'edit', state: { status: 'completed', title: 'timer.ts', input: { file_path: 'src/timer.ts' } } })
    ])
  ], { title: 'Tools' })
  assert.ok(markdown.includes('- `bash`: npm test -- --filter timer'))
  assert.ok(markdown.includes('- `edit`: timer.ts'))
  assert.ok(
    markdown.indexOf('- `bash`') < markdown.indexOf('- `edit`'),
    'tool lines keep stream order'
  )
  const lines = markdown.split('\n')
  const bash = lines.findIndex((line) => line.startsWith('- `bash`'))
  assert.ok(bash > 0 && lines[bash + 1]?.startsWith('- `edit`'), 'consecutive calls form one contiguous list')
})

test('a failed or stopped tool call says so on its line', () => {
  const markdown = serializeThreadMarkdown([
    message('assistant', [
      part({ type: 'tool', tool: 'bash', state: { status: 'error', input: { command: 'make' } } }),
      part({ type: 'tool', tool: 'read', state: { status: 'interrupted', input: { file_path: 'a.ts' } } })
    ])
  ], { title: 'F' })
  assert.ok(markdown.includes('- `bash`: make (failed)'))
  assert.ok(markdown.includes('- `read`: a.ts (stopped)'))
})

test('long tool summaries are truncated to one line', () => {
  const command = 'x'.repeat(400)
  const markdown = serializeThreadMarkdown([
    message('assistant', [part({ type: 'tool', tool: 'bash', state: { status: 'completed', input: { command } } })])
  ], { title: 'L' })
  const line = markdown.split('\n').find((item) => item.startsWith('- `bash`'))!
  assert.ok(line.length < 160)
  assert.ok(line.endsWith('…'))
})

test('images become placeholders naming the picture; attachments are named too', () => {
  const markdown = serializeThreadMarkdown([
    message('user', [
      part({ type: 'file', state: { mime: 'image/png', name: 'screenshot.png', url: 'boss-image://x' } }),
      part({ type: 'file', state: { mime: 'application/pdf', path: 'spec.pdf' } })
    ])
  ], { title: 'P' })
  assert.ok(markdown.includes('_[Image: screenshot.png]_'))
  assert.ok(!markdown.includes('boss-image://'))
  assert.ok(markdown.includes('_[Attachment: spec.pdf]_'))
})

test('repeated identical text within a message is emitted once', () => {
  const markdown = serializeThreadMarkdown([
    message('assistant', [
      part({ id: 'a', type: 'text', text: 'Same line.' }),
      part({ id: 'b', type: 'text', text: 'Same   line.' })
    ])
  ], { title: 'D' })
  assert.equal(markdown.match(/Same line\./g)?.length, 1)
})

test('multi-part prose keeps its paragraphs in order', () => {
  const markdown = serializeThreadMarkdown([
    message('assistant', [
      part({ type: 'text', text: 'First paragraph.' }),
      part({ type: 'tool', tool: 'grep', state: { status: 'completed', input: { pattern: 'todo' } } }),
      part({ type: 'text', text: 'Second paragraph.' })
    ])
  ], { title: 'O' })
  const order = ['First paragraph.', '- `grep`', 'Second paragraph.'].map((marker) => markdown.indexOf(marker))
  assert.ok(order.every((index) => index > 0), 'every piece appears')
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'prose, work, prose stays in stream order')
})

test('turns group each user message with the assistant messages after it', () => {
  const turns = groupExportTurns([
    message('user', [part({ type: 'text', text: 'one' })]),
    message('assistant', []),
    message('assistant', []),
    message('user', [part({ type: 'text', text: 'two' })]),
    message('assistant', [])
  ])
  assert.equal(turns.length, 2)
  assert.equal(turns[0].assistants.length, 2)
  assert.equal(turns[1].user?.parts[0].text, 'two')
})

test('several assistant messages in one turn share one Assistant heading', () => {
  const markdown = serializeThreadMarkdown([
    message('user', [part({ type: 'text', text: 'go' })]),
    message('assistant', [part({ type: 'text', text: 'part one.' })]),
    message('assistant', [part({ type: 'text', text: 'part two.' })])
  ], { title: 'S' })
  assert.equal(markdown.match(/### Assistant/g)?.length, 1)
  assert.ok(markdown.includes('part one.\n\npart two.'))
})

test('messages with nothing exportable produce no empty headings', () => {
  const markdown = serializeThreadMarkdown([
    message('user', [part({ type: 'reasoning', text: 'hmm' })]),
    message('assistant', [part({ type: 'step', text: 'step marker' })])
  ], { title: 'E' })
  assert.ok(!markdown.includes('### User'))
  assert.ok(!markdown.includes('### Assistant'))
})

test('an interrupted turn still exports what was streamed before the stop', () => {
  const markdown = serializeThreadMarkdown([
    message('user', [part({ type: 'text', text: 'start this' })]),
    message('assistant', [
      part({ type: 'tool', tool: 'write', state: { status: 'interrupted', input: { path: 'x.ts' } } }),
      part({ type: 'text', text: 'Partial answer before the stop.' })
    ])
  ], { title: 'Interrupted' })
  assert.ok(markdown.includes('- `write`: x.ts (stopped)'))
  assert.ok(markdown.includes('Partial answer before the stop.'))
})

test('code fences pass through untouched', () => {
  const markdown = serializeThreadMarkdown([
    message('assistant', [part({ type: 'text', text: 'Use this:\n\n```ts\nconst a = 1\n```\n' })])
  ], { title: 'Code' })
  assert.ok(markdown.includes('```ts\nconst a = 1\n```'))
})

test('exportFileName slugs the title into a safe .md name', () => {
  assert.equal(exportFileName('Fix the flaky timer!'), 'fix-the-flaky-timer.md')
  assert.equal(exportFileName('../../etc/passwd'), 'etc-passwd.md')
  assert.equal(exportFileName('   '), 'thread.md')
  assert.equal(exportFileName(undefined), 'thread.md')
})
