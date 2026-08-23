import assert from 'node:assert/strict'
import test from 'node:test'
import { escapeHtml, highlightFence, langForFence, langFromClassName, nodeText } from './highlight.ts'

test('the fence tag comes from the language class react-markdown sets', () => {
  assert.equal(langFromClassName('language-typescript'), 'typescript')
  assert.equal(langFromClassName('hljs language-python'), 'python')
  assert.equal(langFromClassName(undefined), undefined)
  assert.equal(langFromClassName('inline-code'), undefined)
})

test('short fence tags resolve through the extension aliases', () => {
  // Fences say ts, js, sh — none of which hljs registers by that name.
  assert.equal(langForFence('ts'), 'typescript')
  assert.equal(langForFence('js'), 'javascript')
  assert.equal(langForFence('sh'), 'bash')
  assert.equal(langForFence('yml'), 'yaml')
})

test('a full language tag passes straight through', () => {
  assert.equal(langForFence('typescript'), 'typescript')
  assert.equal(langForFence('Python'), 'python')
})

test('an unknown or missing tag resolves to nothing', () => {
  assert.equal(langForFence('brainfuck'), undefined)
  assert.equal(langForFence(undefined), undefined)
  assert.equal(langForFence(''), undefined)
})

test('a tagged fence is highlighted with the theme classes', () => {
  const html = highlightFence('const answer = 42\n', 'ts')

  assert.match(html, /hljs-keyword/)
  assert.match(html, /hljs-number/)
})

test('an untagged fence falls back to auto-detection', () => {
  const html = highlightFence('const answer = 42\n', undefined)

  assert.match(html, /hljs-keyword/, 'auto-detect still recognizes obvious code')
})

test('a fence whose content looks like markup is escaped, never raw', () => {
  const html = highlightFence('<script>alert(1)</script>', 'text')

  // The escaped brackets may be wrapped in highlight spans of their own, so
  // the contract is about what never appears: the input's tags as markup.
  assert.ok(!html.includes('<script>'), 'raw markup never reaches innerHTML')
  assert.ok(html.includes('&lt;'))
})

test('nodeText flattens children to their raw code', () => {
  assert.equal(nodeText('const x = 1\n'), 'const x = 1\n')
  assert.equal(nodeText(['con', ['st ', 42]]), 'const 42')
  assert.equal(nodeText(null), '')
  assert.equal(nodeText([{ props: { children: '<element>' } }]), '', 'elements contribute nothing')
})

test('escapeHtml keeps its contract for direct callers', () => {
  assert.equal(escapeHtml('<img src="x">'), '&lt;img src=&quot;x&quot;&gt;')
})
