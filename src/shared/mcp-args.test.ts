import assert from 'node:assert/strict'
import test from 'node:test'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error Application code uses bundler resolution.
import { formatArgs, parseArgs } from './mcp-args.ts'

test('parseArgs splits on whitespace like the old behaviour', () => {
  assert.deepEqual(parseArgs('-y @upstash/context7-mcp@latest'), ['-y', '@upstash/context7-mcp@latest'])
})

test('parseArgs collapses runs of whitespace and trims', () => {
  assert.deepEqual(parseArgs('  a   b\tc  '), ['a', 'b', 'c'])
})

test('parseArgs returns nothing for blank text', () => {
  assert.deepEqual(parseArgs(''), [])
  assert.deepEqual(parseArgs('   '), [])
})

test('parseArgs keeps a quoted argument that contains spaces whole', () => {
  assert.deepEqual(parseArgs('--dir "/Users/me/My Documents"'), ['--dir', '/Users/me/My Documents'])
  assert.deepEqual(parseArgs("--dir '/Users/me/My Documents'"), ['--dir', '/Users/me/My Documents'])
})

test('parseArgs treats quotes as grouping, not content', () => {
  assert.deepEqual(parseArgs('--flag="a b"'), ['--flag=a b'])
  assert.deepEqual(parseArgs('"a"b"c"'), ['abc'])
})

test('parseArgs keeps a JSON argument in one piece', () => {
  assert.deepEqual(parseArgs('--config \'{"a": 1, "b": 2}\''), ['--config', '{"a": 1, "b": 2}'])
})

test('parseArgs honours backslash escapes outside single quotes', () => {
  assert.deepEqual(parseArgs('a\\ b'), ['a b'])
  assert.deepEqual(parseArgs('"a\\"b"'), ['a"b'])
  // Inside single quotes a backslash is literal, as in a shell.
  assert.deepEqual(parseArgs("'a\\b'"), ['a\\b'])
})

test('parseArgs keeps an empty quoted string as an argument', () => {
  assert.deepEqual(parseArgs('a "" b'), ['a', '', 'b'])
})

test('parseArgs returns the partial run of an unterminated quote', () => {
  // The user is still typing; the form must not drop what they have written.
  assert.deepEqual(parseArgs('--dir "/Users/me/My Doc'), ['--dir', '/Users/me/My Doc'])
})

test('formatArgs leaves ordinary arguments bare', () => {
  assert.equal(formatArgs(['-y', '@upstash/context7-mcp@latest']), '-y @upstash/context7-mcp@latest')
})

test('formatArgs quotes only what needs it', () => {
  assert.equal(formatArgs(['--dir', '/Users/me/My Documents']), '--dir "/Users/me/My Documents"')
  assert.equal(formatArgs(['a"b']), '"a\\"b"')
  assert.equal(formatArgs(['a\\b']), '"a\\\\b"')
  assert.equal(formatArgs(['']), '""')
})

test('parse and format round-trip in both directions', () => {
  const argvs = [
    ['-y', '@upstash/context7-mcp@latest'],
    ['--dir', '/Users/me/My Documents'],
    ['--config', '{"a": 1, "b": 2}'],
    ['a b', "c'd", 'e"f', 'g\\h', '', '--flag=x y']
  ]
  for (const argv of argvs) {
    assert.deepEqual(parseArgs(formatArgs(argv)), argv, `round trip failed for ${JSON.stringify(argv)}`)
  }

  const lines = ['-y pkg@latest', '--dir "/a b/c"', "--json '{\"k\": 1}'"]
  for (const line of lines) {
    const argv = parseArgs(line)
    assert.deepEqual(parseArgs(formatArgs(argv)), argv, `round trip failed for ${line}`)
  }
})
