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

test('a server that goes away takes what BOSS believed about it', () => {
  // loadedThreads gates thread/resume. Keeping it across a restart made BOSS
  // skip the resume for a thread it thought was already loaded, and the fresh
  // app-server then rejected the id: "thread not found" for a thread still on
  // disk. Both ways a server can end have to forget it.
  const exit = source.slice(source.indexOf("this.process.on('exit'"), source.indexOf('await this.request(\'initialize\''))
  assert.ok(exit.includes('this.forgetServerState()'), 'the exit handler should forget server state')

  const stop = source.slice(source.indexOf('async stop('), source.indexOf('async setProject('))
  assert.ok(stop.includes('this.forgetServerState()'), 'stop should forget server state')

  const forget = source.slice(source.indexOf('private forgetServerState('))
  for (const cleared of ['loadedThreads.clear()', 'activeTurns.clear()', 'liveText.clear()']) {
    assert.ok(forget.includes(cleared), `expected ${cleared}`)
  }
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

test('network access follows the setting, and plan mode stays offline', () => {
  // Hardcoding networkAccess: false blocked `gh pr create` for every Codex
  // thread. The write sandbox now reads the setting; read-only does not.
  const send = source.slice(source.indexOf('async sendMessage('), source.indexOf('async steer('))
  assert.ok(
    send.includes('networkAccess: this.sandboxSettings.networkAccess'),
    'the workspace-write sandbox should read the setting'
  )
  assert.ok(
    /readOnly',\s*networkAccess: false/.test(send),
    'plan mode should stay offline regardless of the setting'
  )
  assert.ok(
    !/type: 'workspaceWrite'[\s\S]*?networkAccess: false/.test(send),
    'the write sandbox must not hardcode networkAccess: false'
  )
})

test('the sandbox setting arrives before the turn that uses it', () => {
  // The policy goes out with each turn, so a setter that never stored the
  // value would silently leave every thread on the default.
  assert.ok(source.includes('setSandbox(settings: SandboxSettings): void'), 'expected a setSandbox method')
  const setter = source.slice(source.indexOf('setSandbox(settings: SandboxSettings)'))
  assert.ok(
    setter.includes('this.sandboxSettings = { ...settings }'),
    'setSandbox should store the settings the turn reads'
  )
})

test('a reloaded turn reports every message the user sent, not just the first', () => {
  // Codex folds a steered message into the turn it is already running, so one
  // turn carries one userMessage item per thing the user said. Reading only the
  // first dropped the steered text from the reload, and because the reload
  // prunes messages it does not report, the message the user watched appear
  // mid-run was deleted the moment the run ended.
  const start = source.indexOf('function turnMessages(')
  assert.ok(start > 0, 'expected a turnMessages function')
  const turn = source.slice(start, source.indexOf('\n}', source.indexOf('const assistantItems', start)))
  assert.ok(
    !/\.find\(\(item\) => item\.type === 'userMessage'\)/.test(turn),
    'turnMessages must not take only the first userMessage'
  )
  assert.ok(
    /filter\(\(item\) => item\.type === 'userMessage'\)/.test(turn),
    'turnMessages should map every userMessage in the turn'
  )
})
