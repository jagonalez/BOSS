import assert from 'node:assert/strict'
import test from 'node:test'
import { blocks, groupByProject, sortThreads, spans, visibleThreads } from './parts.ts'

const row = (threadId, projectPath, extra = {}) => ({ threadId, projectPath, ...extra })

test('threads are grouped by the project they run in', () => {
  const groups = groupByProject([
    row('a', '/Users/j/dev/BOSS'),
    row('b', '/Users/j/dev/BOSS'),
    row('c', '/Users/j/dev/other')
  ])
  assert.equal(groups.length, 2)
  const boss = groups.find((g) => g.name === 'BOSS')
  assert.equal(boss.threads.length, 2)
})

test('a project needing a person sorts above a busier one that does not', () => {
  // The reason to open the phone at all is that something is waiting, so that
  // has to outrank recency.
  const groups = groupByProject([
    row('recent', '/dev/quiet', { updatedAt: 9_000 }),
    row('asking', '/dev/waiting', { updatedAt: 1, attention: { kind: 'permission' } })
  ])
  assert.equal(groups[0].name, 'waiting')
  assert.equal(groups[0].waiting, 1)
})

test('threads with no project collect together rather than disappearing', () => {
  const groups = groupByProject([row('a'), row('b', '/dev/x')])
  const orphans = groups.find((g) => g.name === 'No project')
  assert.equal(orphans.threads.length, 1)
})

test('running and waiting counts are per project', () => {
  const groups = groupByProject([
    row('a', '/dev/x', { running: true }),
    row('b', '/dev/x', { attention: { kind: 'question' } }),
    row('c', '/dev/y', { running: true })
  ])
  const x = groups.find((g) => g.name === 'x')
  assert.equal(x.running, 1)
  assert.equal(x.waiting, 1)
})

test('archived and delegated threads are hidden, as they are on the desktop', () => {
  // The reported bug: 58 threads on the phone against 26 on the desktop.
  // Archiving lived in one browser's localStorage, so no other client could
  // know, and delegated workers were listed as peers of their parent.
  const rows = [
    { threadId: 'plain' },
    { threadId: 'archived', archived: true },
    { threadId: 'worker', parentID: 'plain' }
  ]
  assert.deepEqual(visibleThreads(rows).map((t) => t.threadId), ['plain'])
})

test('threads sort by time, except those blocked on a person', () => {
  const rows = [
    { threadId: 'old', updatedAt: 1 },
    { threadId: 'new', updatedAt: 9 },
    { threadId: 'asking', updatedAt: 2, attention: { kind: 'permission' } }
  ]
  assert.deepEqual(sortThreads(rows).map((t) => t.threadId), ['asking', 'new', 'old'])
})

test('a finished or failed thread does not jump the queue', () => {
  // These used to rank above merely-recent threads and colour the row red or
  // green, which told you the past rather than what to do.
  const rows = [
    { threadId: 'failed', updatedAt: 1, attention: { kind: 'error' } },
    { threadId: 'done', updatedAt: 2, attention: { kind: 'completed' } },
    { threadId: 'recent', updatedAt: 8 }
  ]
  assert.deepEqual(sortThreads(rows).map((t) => t.threadId), ['recent', 'done', 'failed'])
})


test('inline code wins over the emphasis inside it', () => {
  // Agents write `**kwargs` and `__init__` constantly. Reading those as bold
  // would eat the asterisks and the meaning with them.
  const runs = spans('call `foo(**kwargs)` now')
  assert.deepEqual(runs.map((r) => r.kind), ['plain', 'code', 'plain'])
  assert.equal(runs[1].text, 'foo(**kwargs)')
})

test('bold, italic and strikethrough each survive alongside plain text', () => {
  assert.deepEqual(
    spans('a **b** c *d* e ~~f~~').map((r) => [r.kind, r.text]),
    [['plain', 'a '], ['bold', 'b'], ['plain', ' c '], ['italic', 'd'], ['plain', ' e '], ['strike', 'f']]
  )
})

test('a link keeps its text and its destination', () => {
  const [link] = spans('[the docs](https://example.com/x)')
  assert.equal(link.kind, 'link')
  assert.equal(link.text, 'the docs')
  assert.equal(link.href, 'https://example.com/x')
})

test('half-written emphasis stays literal rather than eating the line', () => {
  // Every streaming reply passes through this state on its way to being bold.
  const runs = spans('this is **half written')
  assert.equal(runs.length, 1)
  assert.equal(runs[0].kind, 'plain')
  assert.equal(runs[0].text, 'this is **half written')
})

test('snake_case is not italics', () => {
  const runs = spans('call some_function_name here')
  assert.equal(runs.length, 1)
  assert.equal(runs[0].kind, 'plain')
})

test('headings carry their depth', () => {
  const out = blocks('# One\n### Three')
  assert.deepEqual(out.map((b) => [b.kind, b.level, b.content]), [
    ['heading', 1, 'One'],
    ['heading', 3, 'Three']
  ])
})

test('bullets and numbered items keep their nesting and their numbers', () => {
  const out = blocks('- top\n  - nested\n3. third\n4) fourth')
  assert.deepEqual(out.map((b) => [b.kind, b.indent, b.marker ?? null, b.content]), [
    ['bullet', 0, null, 'top'],
    ['bullet', 1, null, 'nested'],
    ['number', 0, '3', 'third'],
    ['number', 0, '4', 'fourth']
  ])
})

test('a horizontal rule is not read as a bullet', () => {
  const out = blocks('above\n---\nbelow')
  assert.deepEqual(out.map((b) => b.kind), ['text', 'rule', 'text'])
})

test('markdown inside a fence stays literal', () => {
  const out = blocks('```js\n# not a heading\n- not a bullet\n```')
  assert.equal(out.length, 1)
  assert.equal(out[0].kind, 'code')
  assert.equal(out[0].language, 'js')
  assert.match(out[0].content, /# not a heading/)
})

test('an unterminated fence still renders as code', () => {
  // What every streaming reply looks like halfway through writing a block.
  const out = blocks('text\n```py\nprint(1)')
  assert.deepEqual(out.map((b) => b.kind), ['text', 'code'])
  assert.equal(out[1].content, 'print(1)')
})

test('a blockquote drops its marker and keeps its text', () => {
  const [quote] = blocks('> quoted thing')
  assert.equal(quote.kind, 'quote')
  assert.equal(quote.content, 'quoted thing')
})

test('bold code renders as both, not as backticks in bold', () => {
  // Agents write **`supervision.search`** constantly. A flat parser bolds the
  // run and leaves the backticks showing, which is how this was first written.
  const [span] = spans('**`supervision.search`**')
  assert.equal(span.kind, 'bold')
  assert.equal(span.children.length, 1)
  assert.equal(span.children[0].kind, 'code')
  assert.equal(span.children[0].text, 'supervision.search')
})

test('a link can hold emphasis and keeps its destination', () => {
  const [link] = spans('[**bold link**](https://x.dev)')
  assert.equal(link.kind, 'link')
  assert.equal(link.href, 'https://x.dev')
  assert.equal(link.children[0].kind, 'bold')
})

test('code is literal all the way down', () => {
  // The one span that must not recurse: backticks mean "leave this alone".
  const [span] = spans('`**not bold**`')
  assert.equal(span.kind, 'code')
  assert.equal(span.text, '**not bold**')
  assert.equal(span.children, undefined)
})

test('a plain-only run carries no redundant children', () => {
  const [span] = spans('**just bold**')
  assert.equal(span.kind, 'bold')
  assert.equal(span.children, undefined)
})
