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

test('a user message keeps one id whether it streamed or was reloaded', () => {
  // Codex names the same user message two ways: item/completed carries a fresh
  // uuid, while thread/read renumbers the turn's items as item-1, item-2, …
  // Storing the streamed uuid meant the reload never reported that id, and
  // reconcile — which deletes what native history omits — dropped every user
  // message in the thread. Only the assistant text, keyed by the stable turn
  // id, survived; that is the "scroll up and my messages are gone" report.
  // Both sides must derive the id from the turn id, which the live event and
  // the reload agree on.
  assert.ok(
    /function codexUserMessageId\(turnId: string, index: number\)/.test(source),
    'expected a shared user message id helper'
  )

  const live = source.slice(source.indexOf("case 'item/started':"), source.indexOf("case 'item/agentMessage/delta':"))
  assert.ok(
    live.includes('codexUserMessageId('),
    'the live path must derive the user message id from the turn, not item.id'
  )
  assert.ok(
    !/item\.type === 'userMessage' \? item\.id/.test(live),
    'the live path must not key a user message by the volatile item id'
  )

  const turn = source.slice(source.indexOf('function turnMessages('), source.indexOf('\n}', source.indexOf('const assistantItems')))
  assert.ok(
    turn.includes('codexUserMessageId('),
    'the reload path must derive the user message id the same way'
  )
  assert.ok(!/const id = user\.id/.test(turn), 'the reload must not key a user message by item.id')
})

test('streamed user ordinals are per turn and do not outlive it', () => {
  // item/started and item/completed both fire for one item, so the ordinal is
  // keyed by item id rather than incremented per event — counting twice would
  // give the same message two ids and reintroduce the prune. The entries are
  // only useful while the turn streams, so the turn's end releases them.
  const ordinal = source.slice(source.indexOf('private userMessageOrdinal('))
  assert.ok(ordinal.includes('seen.indexOf(itemId)'), 'a repeated item must reuse its ordinal')

  const completed = source.slice(source.indexOf("case 'turn/completed':"), source.indexOf("case 'item/started':"))
  assert.ok(completed.includes('this.turnUserItems.delete('), 'a finished turn should release its ordinals')

  const forget = source.slice(source.indexOf('private forgetServerState('))
  assert.ok(forget.includes('turnUserItems.clear()'), 'a lost server should forget streamed ordinals')
})

test('a Codex user image remains a renderable transcript part', () => {
  const helperStart = source.indexOf('function userParts(')
  assert.ok(helperStart > 0, 'expected user content to have a transcript adapter')
  const helper = source.slice(helperStart, source.indexOf('\n}', helperStart))
  assert.ok(helper.includes("type: 'file'"), 'an image should become the renderer\'s file part')
  assert.ok(helper.includes('mime,') && helper.includes('url'), 'the file part must retain its data URL and MIME type')

  const history = source.slice(source.indexOf('function turnMessages('), source.indexOf('export class CodexBackend'))
  assert.ok(history.includes('parts: userParts(sessionId, id, user.content)'), 'history reloads must retain the image')
  const live = source.slice(source.indexOf("case 'item/started':"), source.indexOf("case 'thread/name/updated':"))
  assert.ok(live.includes('userParts(sessionId, messageId, item.content)'), 'live user events must retain the image')
})

test('a tool image becomes a content block rather than base64 in the text', () => {
  // Codex hands an image back as the data URL BOSS sent it. Returning
  // {text, images} put that URL somewhere neither the manager nor the renderer
  // reads: the manager lifts an image only out of an array of content blocks,
  // and the renderer stringifies an output it does not understand — so a
  // screenshot arrived as a wall of base64 in the tool card. The block shape is
  // the one Claude and MCP already use, which is what puts codex on the path
  // that stores the bytes and shows the picture.
  const start = source.indexOf('function dynamicToolOutput(')
  assert.ok(start > 0, 'expected a dynamicToolOutput function')
  const body = source.slice(start, source.indexOf('\n}', start))
  assert.ok(
    !/return\s*\{\s*text,\s*images\s*\}/.test(body),
    'dynamicToolOutput must not return the shape nothing downstream reads'
  )
  assert.ok(
    body.includes("{ type: 'text', text }"),
    'the surviving text should be a text block'
  )
  assert.ok(body.includes('dataUrlImage('), 'an image should be split out of its data URL')

  // The store is handed a mime and base64, so the data URL has to be taken
  // apart rather than passed on whole.
  const helper = source.slice(source.indexOf('function dataUrlImage('))
  assert.ok(helper.includes("type: 'image'"), 'the block should be an image block')
  assert.ok(/mimeType/.test(helper) && /data/.test(helper), 'it should carry mimeType and data')
})

test('title generation is a bounded structured turn in an ephemeral thread', () => {
  const generate = source.slice(source.indexOf('async generateTitle('), source.indexOf('private async ensureLoaded('))
  assert.ok(generate.includes('ephemeral: true'), 'title work must not create a persisted user thread')
  assert.ok(generate.includes("effort: 'low'"), 'the title turn should keep reasoning cost low')
  assert.ok(generate.includes('outputSchema:'), 'the title turn should constrain the response shape')
  assert.ok(generate.includes('.slice(0, 1_600)'), 'a long first prompt should not become a long title request')

  const notifications = source.slice(source.indexOf('private mapNotification('), source.indexOf('async sessionsList('))
  assert.ok(notifications.indexOf('const titleRun') < notifications.indexOf('switch (method)'), 'ephemeral title events should be intercepted')
  assert.ok(notifications.includes('this.finishTitleRun(sessionId'), 'completion should settle the pending title')
})
