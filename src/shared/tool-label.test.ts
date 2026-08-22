import assert from 'node:assert/strict'
import test from 'node:test'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error Application code uses bundler resolution.
import { shortPath, toolLabel } from './tool-label.ts'

test('a shell call is named by its command', () => {
  assert.equal(toolLabel('Bash', { command: 'npm test' }), '$ npm test')
  assert.equal(toolLabel('bash', { command: 'git status' }), '$ git status')
})

test('a multi-line command collapses onto one row', () => {
  assert.equal(toolLabel('Bash', { command: 'for f in *; do\n  echo "$f"\ndone' }), '$ for f in *; do echo "$f" done')
})

test('a long command is cut rather than allowed to fill the row', () => {
  const label = toolLabel('Bash', { command: `echo ${'x'.repeat(400)}` })
  assert.ok(label && label.length <= 120, `expected a label a row can hold, got ${label?.length}`)
  assert.ok(label?.endsWith('…'), 'a cut label should say it was cut')
})

test('a file call is named by the end of its path', () => {
  assert.equal(toolLabel('Read', { file_path: '/Users/me/dev/BOSS/src/main/index.ts' }), '…/main/index.ts')
  assert.equal(toolLabel('Write', { filePath: 'src/shared/review.ts' }), '…/shared/review.ts')
  // A short path is already readable, so it is left whole.
  assert.equal(toolLabel('Read', { file_path: 'package.json' }), 'package.json')
  assert.equal(toolLabel('Read', { file_path: 'src/index.ts' }), 'src/index.ts')
})

test('a search says where it looked', () => {
  // Two greps for the same pattern are one row until the haystack is named.
  assert.equal(toolLabel('Grep', { pattern: 'useState', path: 'src/renderer' }), 'useState in src/renderer')
  assert.equal(toolLabel('Grep', { pattern: 'useState' }), 'useState')
})

test('the identifying argument is chosen by priority, not by object order', () => {
  // An agent spawn carries both, and the description is the one written to be read.
  assert.equal(toolLabel('Task', { prompt: 'a very long prompt', description: 'Find the bug' }), 'Find the bug')
  // A command outranks a path on a tool that carries both.
  assert.equal(toolLabel('Bash', { path: '/tmp', command: 'ls' }), '$ ls')
})

test('a tool with one string argument is named by it whatever it is called', () => {
  assert.equal(toolLabel('SomeMcpTool', { unexpectedKey: 'the only value' }), 'the only value')
})

test('a call whose arguments say nothing keeps its tool name', () => {
  // undefined means "no better label than the tool's own name".
  assert.equal(toolLabel('TodoWrite', {}), undefined)
  assert.equal(toolLabel('Bash', undefined), undefined)
  assert.equal(toolLabel('Bash', null), undefined)
  assert.equal(toolLabel('Bash', 'not an object'), undefined)
  assert.equal(toolLabel('Bash', ['an', 'array']), undefined)
  // Several strings with no identifying key is ambiguous, so nothing is guessed.
  assert.equal(toolLabel('Odd', { a: 'one', b: 'two' }), undefined)
  // Whitespace is not a label.
  assert.equal(toolLabel('Bash', { command: '   ' }), undefined)
})

test('shortPath keeps the last two segments', () => {
  assert.equal(shortPath('/a/b/c/d.ts'), '…/c/d.ts')
  assert.equal(shortPath('a/b'), 'a/b')
  assert.equal(shortPath('d.ts'), 'd.ts')
  assert.equal(shortPath('/a/b/c/'), '…/b/c')
})
