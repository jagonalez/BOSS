import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Codex imports @shared as a value, an alias only the bundler resolves, so the
 *  class cannot be constructed here. Reading the source is enough to hold the
 *  wiring in place: the risk is a call site quietly going back to the global
 *  path, and that is visible in the text. */
const source = readFileSync(join(import.meta.dirname, 'codex-backend.ts'), 'utf8')

test('every per-thread request uses the thread checkout, not the global path', () => {
  // A thread in one project must not read, or be given write access to,
  // whichever project happened to be selected last.
  for (const call of ['cwd: this.directoryFor(sessionId)', 'this.directoryFor(sessionId)']) {
    assert.ok(source.includes(call), `expected ${call}`)
  }

  // sendMessage passes writableRoots to the sandbox. Scoped to the thread.
  const send = source.slice(source.indexOf('async sendMessage('), source.indexOf('async sessionAbort('))
  assert.ok(send.includes('this.directoryFor(sessionId)'), 'sendMessage should resolve the thread directory')
  assert.ok(
    !/writableRoots:\s*this\.projectPath/.test(send),
    'writableRoots must not come from the global project path'
  )
})

test('the global project path is only a fallback', () => {
  // Reaching for it directly is what caused the bug, so it should appear in
  // the resolver and in server startup, not scattered through request builders.
  const perThread = source.split('\n').filter((line) =>
    line.includes('this.projectPath') && line.includes('cwd:') && !line.includes('directoryFor')
  )
  assert.deepEqual(
    perThread.filter((line) => line.includes('sessionId')),
    [],
    'a request for one thread should not read the global path'
  )
})
