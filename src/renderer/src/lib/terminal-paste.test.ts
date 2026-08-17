import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizePaste } from './terminal-paste.ts'

test('a single line pastes as it is', () => {
  const result = normalizePaste('npm run build')
  assert.equal(result.text, 'npm run build')
  assert.equal(result.needsConfirm, false)
  assert.equal(result.lineCount, 1)
})

test('a copied command loses the newline that would run it', () => {
  // Selecting a command in a thread or a web page takes the line ending too.
  // Keeping it would submit the command the moment it lands at the prompt.
  for (const copied of ['npm run build\n', 'npm run build\r\n', 'npm run build\n   ']) {
    const result = normalizePaste(copied)
    assert.equal(result.text, 'npm run build')
    assert.equal(result.needsConfirm, false, `should not ask about ${JSON.stringify(copied)}`)
  }
})

test('genuinely multi-line text is asked about, not trimmed', () => {
  const result = normalizePaste('cd /tmp\nrm -rf build\n')
  assert.equal(result.needsConfirm, true)
  assert.equal(result.lineCount, 3)
  // The text is untouched: the question is whether to send it, not what to send.
  assert.equal(result.text, 'cd /tmp\nrm -rf build\n')
})

test('a second line with content is not treated as a stray newline', () => {
  const result = normalizePaste('echo one\necho two')
  assert.equal(result.needsConfirm, true)
  assert.equal(result.lineCount, 2)
})

test('empty text asks nothing', () => {
  const result = normalizePaste('')
  assert.equal(result.text, '')
  assert.equal(result.needsConfirm, false)
})
