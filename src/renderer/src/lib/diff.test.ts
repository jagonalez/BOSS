import assert from 'node:assert/strict'
import test from 'node:test'
import type { DiffLine } from './diff.ts'
import { ignoreWhitespaceChanges, pairModifiedCounterparts, pairSplitLines, parseGitDiff, parseGitStatusPorcelain, segmentWords, wordSegments } from './diff.ts'

function line(kind: DiffLine['kind'], text: string, oldNo: number | null = null, newNo: number | null = null): DiffLine {
  return { kind, oldNo, newNo, text }
}

test('split pairing puts context on both sides', () => {
  const rows = pairSplitLines([
    line('ctx', 'shared', 1, 1),
    line('del', 'gone', 2),
    line('add', 'here', null, 2)
  ])
  assert.deepEqual(rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null]), [
    ['shared', 'shared'],
    ['gone', 'here']
  ])
})

test('split pairing leaves unmatched deletions and additions on their own row', () => {
  const rows = pairSplitLines([
    line('del', 'a1', 1),
    line('del', 'a2', 2),
    line('add', 'b1', null, 1)
  ])
  assert.deepEqual(rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null]), [
    ['a1', 'b1'],
    ['a2', null]
  ])
  const other = pairSplitLines([line('add', 'only', null, 5)])
  assert.deepEqual(other.map((r) => [r.left?.text ?? null, r.right?.text ?? null]), [[null, 'only']])
})

test('split pairing spans hunk markers once across both sides', () => {
  const rows = pairSplitLines([line('hunk', '@@ -1,2 +1,2 @@')])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].hunk, '@@ -1,2 +1,2 @@')
  assert.equal(rows[0].left, null)
  assert.equal(rows[0].right, null)
})

test('modified counterparts pair the k-th deletion with the k-th addition in a block', () => {
  const lines = parseGitDiff('@@ -1,3 +1,3 @@\n ctx\n-old one\n-old two\n+new one\n+new two\n tail')
  const pairs = pairModifiedCounterparts(lines)
  const dels = lines.filter((l) => l.kind === 'del')
  const adds = lines.filter((l) => l.kind === 'add')
  assert.deepEqual(pairs.get(lines.indexOf(dels[0])), lines.indexOf(adds[0]))
  assert.deepEqual(pairs.get(lines.indexOf(dels[1])), lines.indexOf(adds[1]))
  // Context lines have no counterpart.
  for (const l of lines.filter((x) => x.kind === 'ctx')) assert.equal(pairs.has(lines.indexOf(l)), false)
})

test('word segmentation keeps separators so segments rejoin exactly', () => {
  const text = 'foo.bar baz,\tqux!'
  assert.equal(segmentWords(text).join(''), text)
})

test('word diff marks only what changed between two lines', () => {
  const segments = wordSegments('const total = compute(a, b)', 'const sum = compute(a, b)')
  assert.deepEqual(segments.filter((s) => s.kind !== 'eq'), [
    { kind: 'del', text: 'total' },
    { kind: 'add', text: 'sum' }
  ])
  // Reassembling each side from its own kinds reproduces the original line.
  assert.equal(segments.filter((s) => s.kind !== 'add').map((s) => s.text).join(''), 'const total = compute(a, b)')
  assert.equal(segments.filter((s) => s.kind !== 'del').map((s) => s.text).join(''), 'const sum = compute(a, b)')
})

test('word diff handles a fully replaced line and an empty side', () => {
  assert.deepEqual(wordSegments('', 'fresh'), [{ kind: 'add', text: 'fresh' }])
  assert.deepEqual(wordSegments('old', ''), [{ kind: 'del', text: 'old' }])
  const all = wordSegments('aaa', 'bbb')
  assert.deepEqual(all, [
    { kind: 'del', text: 'aaa' },
    { kind: 'add', text: 'bbb' }
  ])
})

test('word diff falls back to whole-line marks before its LCS becomes quadratic', () => {
  const oldText = Array.from({ length: 600 }, (_, i) => `old${i}`).join(' ')
  const newText = Array.from({ length: 600 }, (_, i) => `new${i}`).join(' ')
  assert.deepEqual(wordSegments(oldText, newText), [
    { kind: 'del', text: oldText },
    { kind: 'add', text: newText }
  ])
})

test('ignoring whitespace folds space-only edits back into context', () => {
  const out = ignoreWhitespaceChanges(parseGitDiff([
    '@@ -1,4 +1,4 @@',
    ' unchanged',
    '-indented   with   runs',
    '+indented with runs',
    '-really removed',
    '+actually added',
    ' stable'
  ].join('\n')))
  assert.deepEqual(out.map((l) => l.kind), ['hunk', 'ctx', 'ctx', 'del', 'add', 'ctx'])
  // The folded context carries both numbers and shows the incoming text.
  assert.equal(out[2].kind, 'ctx')
  assert.equal(out[2].text, 'indented with runs')
  assert.ok(out[2].oldNo !== null && out[2].newNo !== null)
})

test('ignoring whitespace keeps real changes inside a mixed block', () => {
  const out = ignoreWhitespaceChanges(parseGitDiff([
    '@@ -1,2 +1,2 @@',
    '-kept   spacing but new words too',
    '+kept spacing but different words here'
  ].join('\n')))
  // Nothing pairs up, so both sides survive untouched.
  assert.deepEqual(out.map((l) => l.kind), ['hunk', 'del', 'add'])
})

test('ignoring whitespace leaves oversized change blocks untouched', () => {
  const lines: DiffLine[] = [line('hunk', '@@')]
  for (let i = 0; i < 1_001; i++) lines.push(line('del', `old ${i}`, i + 1))
  for (let i = 0; i < 1_001; i++) lines.push(line('add', `new ${i}`, null, i + 1))
  const out = ignoreWhitespaceChanges(lines)
  assert.deepEqual(out, lines)
})

test('status parsing splits renames into old and new paths', () => {
  const parsed = parseGitStatusPorcelain([
    '## main',
    'M  src/staged.ts',
    'MM src/partial.ts',
    ' R src/later.ts',
    '?? scratch.ts',
    'R  src/old-name.ts -> src/new-name.ts',
    ' D src/deleted-later.ts'
  ].join('\n'))
  assert.equal(parsed.branch, 'main')
  const renamed = parsed.files.find((f) => f.path === 'src/new-name.ts')
  assert.deepEqual(renamed, { path: 'src/new-name.ts', oldPath: 'src/old-name.ts', staged: true, unstaged: false, untracked: false })
  assert.deepEqual(parsed.files.find((f) => f.path === 'scratch.ts'), { path: 'scratch.ts', oldPath: undefined, staged: false, unstaged: false, untracked: true })
  assert.deepEqual(parsed.files.find((f) => f.path === 'src/deleted-later.ts'), { path: 'src/deleted-later.ts', oldPath: undefined, staged: false, unstaged: true, untracked: false })
})

test('NUL-delimited status preserves raw unusual paths and rename sides', () => {
  const parsed = parseGitStatusPorcelain([
    '?? a b.txt',
    '?? arrow -> name.txt',
    '?? é.ts',
    'R  new name.ts',
    'old name.ts',
    ''
  ].join('\0'))
  assert.deepEqual(parsed.files, [
    { path: 'a b.txt', oldPath: undefined, staged: false, unstaged: false, untracked: true },
    { path: 'arrow -> name.txt', oldPath: undefined, staged: false, unstaged: false, untracked: true },
    { path: 'é.ts', oldPath: undefined, staged: false, unstaged: false, untracked: true },
    { path: 'new name.ts', oldPath: 'old name.ts', staged: true, unstaged: false, untracked: false }
  ])
})
