import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
// @ts-expect-error Application code uses bundler resolution.
import { LabBackend } from './lab-backend.ts'
// @ts-expect-error Application code uses bundler resolution.
import { LabSessionStore } from './lab-session-store.ts'

const textChunk = (text: string): string => `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`

function toolCallChunk(call: { id: string; name: string; arguments: string }): string {
  return `data: ${JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index: 0, id: call.id, function: { name: call.name, arguments: call.arguments } }] }, finish_reason: null }]
  })}\n\n`
}

const done = (): string => 'data: [DONE]\n\n'

async function listen(server: Server): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  }
}

interface OrchestrationFixture {
  readStore: () => LabSessionStore
  cwd: string
  backend: LabBackend
  sessionId: string
  cleanup: () => void
}

function makeFixture(
  dir: string,
  storeFile: string,
  configFile: string,
  cwd: string,
  serveChat: (req: import('node:http').IncomingMessage, res: ServerResponse) => void
): Promise<OrchestrationFixture> {
  const originalBaseUrl = process.env.LAB_BASE_URL
  const server = createServer((req, res) => {
    if (req.url === '/v1/chat/completions') {
      serveChat(req, res)
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: [] }))
  })
  return listen(server).then(({ baseUrl, close }) => {
    process.env.LAB_BASE_URL = baseUrl
    const backend = new LabBackend({ storeFile, configFile })
    return backend.sessionCreate('parent', cwd).then((session) => ({
      readStore: () => new LabSessionStore(storeFile),
      cwd,
      backend,
      sessionId: session.id,
      cleanup: () => {
        process.env.LAB_BASE_URL = originalBaseUrl
        void close()
        rmSync(dir, { recursive: true, force: true })
      }
    }))
  })
}

/** Boot a LabBackend against a mock OpenAI server. The mock serves chat
 *  completions from an ordered queue; a `undefined` slot holds the connection
 *  open (used for abort tests). Every store access goes through `readStore()`
 *  because each LabSessionStore instance snapshots its file at construction. */
function fixture(
  chatResponses: Array<((res: ServerResponse) => void) | undefined>,
  onChildRequest?: () => void
): Promise<OrchestrationFixture> {
  const dir = mkdtempSync(join(tmpdir(), 'boss-lab-orchestrate-'))
  const storeFile = join(dir, 'lab-threads.json')
  const configFile = join(dir, 'lab-config.json')
  const cwd = join(dir, 'project')
  mkdirSync(cwd, { recursive: true })

  let chatIndex = 0
  return makeFixture(dir, storeFile, configFile, cwd, (_req, res) => {
    if (onChildRequest && chatIndex === 1) onChildRequest()
    const writer = chatResponses[chatIndex++]
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    if (writer) writer(res)
    else res.on('close', () => res.destroy())
  })
}

/** Like fixture, but hands each chat request its parsed body so a test can
 *  respond based on what the model just sent (e.g. echo a sub-agent id back). */
function bodyFixture(
  chatHandler: (index: number, body: Record<string, unknown>) => ((res: ServerResponse) => void) | undefined,
  onChildRequest?: () => void
): Promise<OrchestrationFixture> {
  const dir = mkdtempSync(join(tmpdir(), 'boss-lab-orchestrate-'))
  const storeFile = join(dir, 'lab-threads.json')
  const configFile = join(dir, 'lab-config.json')
  const cwd = join(dir, 'project')
  mkdirSync(cwd, { recursive: true })

  let chatIndex = 0
  return makeFixture(dir, storeFile, configFile, cwd, (req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => { raw += chunk.toString() })
    req.on('end', () => {
      let body: Record<string, unknown> = {}
      try { body = JSON.parse(raw) as Record<string, unknown> } catch { /* malformed request */ }
      if (onChildRequest && chatIndex === 1) onChildRequest()
      const writer = chatHandler(chatIndex++, body)
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (writer) writer(res)
      else res.on('close', () => res.destroy())
    })
  })
}

function poll<T>(check: () => T | Promise<T>, until: (value: T) => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = async (): Promise<void> => {
      let value: T
      try { value = await check() } catch { value = undefined as unknown as T }
      if (until(value)) return resolve()
      if (Date.now() - start > timeoutMs) return reject(new Error('timed out waiting for condition'))
      setTimeout(() => void tick(), 20)
    }
    void tick()
  })
}

interface SpawnPart {
  state?: { tool?: string; status?: string; output?: unknown }
}

function spawnParts(store: LabSessionStore, sessionId: string): SpawnPart[] {
  const parts: SpawnPart[] = []
  for (const message of store.messages(sessionId)) {
    for (const part of message.parts) {
      if (part.type === 'tool' && part.state?.tool === 'spawn_subagent') parts.push(part as SpawnPart)
    }
  }
  return parts
}

test('a parent spawns a child, waits for it, and collects its summary', async () => {
  const parentToolTurn = (res: ServerResponse): void => {
    res.write(toolCallChunk({ id: 'spawn-1', name: 'spawn_subagent', arguments: '{"instruction":"Write a parser test","title":"parser-tests"}' }))
    res.write(done())
    res.end()
  }
  const childTurn = (res: ServerResponse): void => {
    res.write(textChunk('child done: built the parser test suite'))
    res.write(done())
    res.end()
  }
  const parentFinalTurn = (res: ServerResponse): void => {
    res.write(textChunk('all done'))
    res.write(done())
    res.end()
  }

  const fx = await fixture([parentToolTurn, childTurn, parentFinalTurn])
  try {
    await fx.backend.sendMessage(fx.sessionId, [{ type: 'text', text: 'Delegate the parser work.' }], { mode: 'auto' })

    // The child exists, is tracked under the parent, and finished.
    assert.equal(fx.readStore().childrenOf(fx.sessionId).length, 1)
    const child = fx.readStore().childrenOf(fx.sessionId)[0]
    assert.equal(child.parentID, fx.sessionId)
    assert.equal(child.status, 'completed')
    assert.equal(fx.readStore().lastAssistantText(child.id), 'child done: built the parser test suite')

    // The parent's final turn arrived and references the work.
    await poll(() => fx.backend.messagesList(fx.sessionId), (messages) => {
      const last = messages.at(-1)
      return Boolean(last?.info.role === 'assistant' && last.parts.some((part) => part.text?.includes('all done')))
    })

    // The spawn tool part carries the child's summary to the parent.
    const spawnPart = spawnParts(fx.readStore(), fx.sessionId)[0]
    assert.ok(spawnPart)
    assert.match(String(spawnPart.state?.output), /completed/)
    assert.match(String(spawnPart.state?.output), /child done: built the parser test suite/)
  } finally {
    fx.cleanup()
  }
})

test('a parent in plan mode cannot spawn a sub-agent', async () => {
  const parentToolTurn = (res: ServerResponse): void => {
    res.write(toolCallChunk({ id: 'spawn-1', name: 'spawn_subagent', arguments: '{"instruction":"clean up"}' }))
    res.write(done())
    res.end()
  }
  const parentFinalTurn = (res: ServerResponse): void => {
    res.write(textChunk('ok, standing by'))
    res.write(done())
    res.end()
  }
  const fx = await fixture([parentToolTurn, parentFinalTurn])
  try {
    await fx.backend.sendMessage(fx.sessionId, [{ type: 'text', text: 'Delegate cleanup.' }], { mode: 'plan' })

    await poll(() => fx.readStore(), (store) => {
      const parts = spawnParts(store, fx.sessionId)
      return parts.some((part) => String(part.state?.output).includes('Permission denied'))
    })
    const [spawnPart] = spawnParts(fx.readStore(), fx.sessionId)
    assert.match(String(spawnPart.state?.output), /Permission denied/)
    // The child was never started.
    assert.equal(fx.readStore().childrenOf(fx.sessionId).length, 0)
  } finally {
    fx.cleanup()
  }
})

test('aborting the parent cancels a running child', async () => {
  let childRequested: () => void = () => {}
  const childArrived = new Promise<void>((resolve) => { childRequested = resolve })
  const parentToolTurn = (res: ServerResponse): void => {
    res.write(toolCallChunk({ id: 'spawn-1', name: 'spawn_subagent', arguments: '{"instruction":"work forever","title":"worker"}' }))
    res.write(done())
    res.end()
  }
  // The child's turn never finishes on its own; it only ends when aborted.
  const childTurn = (_res: ServerResponse): void => {}

  const fx = await fixture([parentToolTurn, childTurn], () => childRequested())
  try {
    const send = fx.backend.sendMessage(fx.sessionId, [{ type: 'text', text: 'Delegate the long job.' }], { mode: 'auto' })
    await childArrived
    await new Promise((resolve) => setTimeout(resolve, 30))
    await fx.backend.abort(fx.sessionId)
    await send

    await poll(() => fx.readStore().childrenOf(fx.sessionId)[0]?.status, (status) => status === 'aborted')
    assert.equal(fx.readStore().childrenOf(fx.sessionId)[0]?.status, 'aborted')
  } finally {
    fx.cleanup()
  }
})

test('a parent can fan out: spawn without waiting, then wait_subagent collects', async () => {
  const fx = await bodyFixture((_index, body) => {
    const messages = (body.messages ?? []) as Array<{ role?: string; content?: unknown }>
    const toolResults = messages.filter((message) => message.role === 'tool')
    const childId = [...toolResults].reverse()
      .map((message) => String(message.content))
      .map((content) => content.match(/Spawned sub-agent "[^"]*" \(([0-9a-f-]+)\)/)?.[1])
      .find(Boolean)
    const userText = messages.filter((message) => message.role === 'user').map((message) => String(message.content)).join(' ')
    const alreadyWaited = toolResults.some((message) => String(message.content).startsWith('Sub-agent'))
    if (alreadyWaited) {
      // Turn 3: the wait already ran; the model just wraps up.
      return (res) => {
        res.write(textChunk('all collected'))
        res.write(done())
        res.end()
      }
    }
    if (childId) {
      // Turn 2: the model read the spawn output and collects the worker.
      return (res) => {
        res.write(toolCallChunk({ id: 'wait-1', name: 'wait_subagent', arguments: `{"subagent_id":"${childId}"}` }))
        res.write(done())
        res.end()
      }
    }
    if (toolResults.length === 0 && userText.includes('Fan out and collect.')) {
      // Turn 1: the model launches a background worker.
      return (res) => {
        res.write(toolCallChunk({ id: 'spawn-1', name: 'spawn_subagent', arguments: '{"instruction":"do the work","title":"worker","wait":false}' }))
        res.write(done())
        res.end()
      }
    }
    if (userText.includes('do the work')) {
      // The background child's own turn.
      return (res) => {
        res.write(textChunk('background child did the work'))
        res.write(done())
        res.end()
      }
    }
    // Turn 3: everything collected.
    return (res) => {
      res.write(textChunk('all collected'))
      res.write(done())
      res.end()
    }
  })
  try {
    await fx.backend.sendMessage(fx.sessionId, [{ type: 'text', text: 'Fan out and collect.' }], { mode: 'auto' })

    const children = fx.readStore().childrenOf(fx.sessionId)
    assert.equal(children.length, 1)
    assert.equal(children[0].status, 'completed')
    assert.equal(fx.readStore().lastAssistantText(children[0].id), 'background child did the work')

    await poll(() => fx.backend.messagesList(fx.sessionId), (messages) => {
      const last = messages.at(-1)
      return Boolean(last?.info.role === 'assistant' && last.parts.some((part) => part.text?.includes('all collected')))
    })
  } finally {
    fx.cleanup()
  }
})

test('"always" answers a permission once and re-grants it on later ask-mode calls', async () => {
  const bashTool = (res: ServerResponse): void => {
    res.write(toolCallChunk({ id: 'bash-1', name: 'bash', arguments: '{"command":"echo hi"}' }))
    res.write(done())
    res.end()
  }
  const ok = (res: ServerResponse): void => {
    res.write(textChunk('ok'))
    res.write(done())
    res.end()
  }
  const fx = await fixture([bashTool, ok, bashTool, ok])
  try {
    const asked: string[] = []
    fx.backend.onEvent((event) => {
      if (event.type === 'permission.asked') {
        asked.push(event.permission.permission)
        void fx.backend.permissionRespond(fx.sessionId, event.permission.id, 'always').catch(() => {})
      }
    })
    // First ask-mode message prompts and the answer records an always-grant.
    await fx.backend.sendMessage(fx.sessionId, [{ type: 'text', text: 'Run the check.' }], { mode: 'ask' })
    assert.deepEqual(asked, ['bash'])
    assert.ok(fx.readStore().get(fx.sessionId).alwaysAllow?.includes('bash'))

    // Second ask-mode message runs the same tool without asking again.
    await fx.backend.sendMessage(fx.sessionId, [{ type: 'text', text: 'Run it again.' }], { mode: 'ask' })
    assert.deepEqual(asked, ['bash'], 'the grant must answer the second request without prompting')

    const bashParts = fx.readStore().messages(fx.sessionId).flatMap((message) => message.parts)
      .filter((part) => part.state?.tool === 'bash')
    assert.equal(bashParts.length, 2)
    assert.ok(bashParts.every((part) => part.state?.status === 'completed'))
  } finally {
    fx.cleanup()
  }
})

test('start() reconciles children left marked running after a crash', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'boss-lab-orchestrate-'))
  const storeFile = join(dir, 'lab-threads.json')
  try {
    const seed = new LabSessionStore(storeFile)
    const parent = seed.create('parent')
    const child = seed.createParented('orphaned', dir, parent.id)
    seed.setStatus(child.id, 'running')

    const originalBaseUrl = process.env.LAB_BASE_URL
    process.env.LAB_BASE_URL = 'http://127.0.0.1:1/v1'
    const backend = new LabBackend({ storeFile, configFile: join(dir, 'lab-config.json') })
    try {
      await backend.start()
    } finally {
      process.env.LAB_BASE_URL = originalBaseUrl
    }
    assert.equal(new LabSessionStore(storeFile).get(child.id).status, 'error')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the tool loop stops early when the model repeats the same call', async () => {
  // The mock always asks for the identical read_file call; the engine must
  // bail out on the third identical call instead of grinding through all rounds.
  const sameCall = (res: ServerResponse): void => {
    res.write(toolCallChunk({ id: 'read-1', name: 'read_file', arguments: '{"path":"x.txt"}' }))
    res.write(done())
    res.end()
  }
  const fx = await fixture([sameCall, sameCall, sameCall])
  try {
    const events: string[] = []
    fx.backend.onEvent((event) => {
      if (event.type === 'session.error') events.push(event.error)
    })
    await fx.backend.sendMessage(fx.sessionId, [{ type: 'text', text: 'look' }], { mode: 'auto' })
    assert.ok(
      events.some((error) => /repeated the same tool call/.test(error)),
      `expected a repeat-loop error, got: ${JSON.stringify(events)}`
    )
    assert.equal(fx.readStore().messages(fx.sessionId).filter((message) => message.info.role === 'assistant').length, 3)
  } finally {
    fx.cleanup()
  }
})
test('the tool loop stops when the model only reads and never answers', async () => {
  // The mock asks for a *different* read_file each round, so the repeat guard
  // cannot fire; the read-only flounder guard must stop it.
  let calls = 0
  const readNext = (res: ServerResponse): void => {
    calls += 1
    res.write(toolCallChunk({ id: `read-${calls}`, name: 'read_file', arguments: `{"path":"f${calls}.txt"}` }))
    res.write(done())
    res.end()
  }
  const fx = await fixture(Array.from({ length: 6 }, () => readNext))
  try {
    const events: string[] = []
    fx.backend.onEvent((event) => {
      if (event.type === 'session.error') events.push(event.error)
    })
    await fx.backend.sendMessage(fx.sessionId, [{ type: 'text', text: 'do something' }], { mode: 'auto' })
    assert.ok(
      events.some((error) => /only read files/.test(error)),
      `expected a read-only-loop error, got: ${JSON.stringify(events)}`
    )
  } finally {
    fx.cleanup()
  }
})

test('the todos tool records the model task list and emits an update', async () => {
  const todosTurn = (res: ServerResponse): void => {
    res.write(toolCallChunk({ id: 'todos-1', name: 'todos', arguments: '{"todos":[{"content":"step one","status":"in_progress"},{"content":"step two"}]}' }))
    res.write(done())
    res.end()
  }
  const finalTurn = (res: ServerResponse): void => {
    res.write(textChunk('planned'))
    res.write(done())
    res.end()
  }
  const fx = await fixture([todosTurn, finalTurn])
  try {
    const todosEvents: unknown[][] = []
    fx.backend.onEvent((event) => {
      if (event.type === 'session.todo.updated') todosEvents.push(event.todos)
    })
    await fx.backend.sendMessage(fx.sessionId, [{ type: 'text', text: 'make a plan' }], { mode: 'auto' })
    const stored = fx.readStore().todosOf(fx.sessionId)
    assert.equal(stored.length, 2)
    assert.equal(stored[0].content, 'step one')
    assert.equal(stored[0].status, 'in_progress')
    assert.equal(stored[1].status, 'pending')
    assert.ok(stored.every((todo) => todo.id.length > 0))
    assert.equal(todosEvents.length, 1)
  } finally {
    fx.cleanup()
  }
})

test('compact summarizes older turns and keeps the newest', async () => {
  const reply = (text: string) => (res: ServerResponse): void => {
    res.write(textChunk(text))
    res.write(done())
    res.end()
  }
  // 8 user turns (each: user + assistant = 16 messages) then a summary call.
  const responses = Array.from({ length: 8 }, (_, i) => reply(`reply ${i}`))
  responses[7] = reply('SESSION SUMMARY')
  const fx = await fixture(responses)
  try {
    for (let i = 0; i < 7; i++) {
      await fx.backend.sendMessage(fx.sessionId, [{ type: 'text', text: `msg ${i}` }], { mode: 'auto' })
    }
    assert.equal(fx.readStore().messages(fx.sessionId).length, 14)
    await fx.backend.compact(fx.sessionId)

    const messages = fx.readStore().messages(fx.sessionId)
    // 1 compaction message + the newest 6 messages.
    assert.equal(messages.length, 7)
    assert.equal(messages[0].info.id.startsWith('compaction-'), true)
    assert.equal(messages[0].parts[0].type, 'compaction')
    assert.equal(messages[0].parts[0].text, 'SESSION SUMMARY')
    // The newest messages survived intact.
    assert.ok(messages.some((message) => message.info.role === 'user'))
  } finally {
    fx.cleanup()
  }
})

test('steer folds a message into a running session between tool rounds', async () => {
  let childArrived: () => void = () => {}
  const arrived = new Promise<void>((resolve) => { childArrived = resolve })
  let steeredSeen = false

  const fx = await bodyFixture((index, body) => {
    const messages = (body.messages ?? []) as Array<{ role?: string; content?: unknown }>
    if (index === 0) {
      // Parent turn 1: block on a sub-agent so the test has a window to steer.
      return (res) => {
        res.write(toolCallChunk({ id: 'spawn-1', name: 'spawn_subagent', arguments: '{"instruction":"child work","title":"c"}' }))
        res.write(done())
        res.end()
      }
    }
    if (index === 1) {
      // The child's own turn.
      childArrived()
      return (res) => {
        res.write(textChunk('child done'))
        res.write(done())
        res.end()
      }
    }
    // Parent turn 2: the steered message must be visible to the model.
    steeredSeen = messages.some((message) => message.role === 'user' && String(message.content).includes('steer me'))
    return (res) => {
      res.write(textChunk('ack'))
      res.write(done())
      res.end()
    }
  })
  try {
    const send = fx.backend.sendMessage(fx.sessionId, [{ type: 'text', text: 'go' }], { mode: 'auto' })
    await arrived
    await fx.backend.steer(fx.sessionId, [{ type: 'text', text: 'steer me' }])
    await send
    assert.equal(steeredSeen, true)
  } finally {
    fx.cleanup()
  }
})

test('runCommand compacts and reports unknown commands', async () => {
  const fx = await fixture([(res: ServerResponse) => { res.write(textChunk('reply')); res.write(done()); res.end() }])
  try {
    await fx.backend.sendMessage(fx.sessionId, [{ type: 'text', text: 'seed' }], { mode: 'auto' })
    const compact = await fx.backend.runCommand(fx.sessionId, 'compact', '')
    assert.match(compact.parts[0].text ?? '', /Compacted/)
    const unknown = await fx.backend.runCommand(fx.sessionId, 'nope', '')
    assert.match(unknown.parts[0].text ?? '', /Unknown command/)
  } finally {
    fx.cleanup()
  }
})

test('diffGet, fileTree, and fileContent reflect the working tree', async () => {
  const fx = await fixture([(res: ServerResponse) => { res.write(textChunk('ok')); res.write(done()); res.end() }])
  try {
    // Seed a git repo in the session's directory with one committed file.
    const dir = fx.cwd
    execFileSync('git', ['init', '-q'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 'lab@test'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'Lab Test'], { cwd: dir })
    writeFileSync(join(dir, 'tracked.txt'), 'one\n')
    execFileSync('git', ['add', 'tracked.txt'], { cwd: dir })
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: dir })
    writeFileSync(join(dir, 'tracked.txt'), 'one\ntwo\n')
    writeFileSync(join(dir, 'untracked.txt'), 'x\n')

    const diffs = await fx.backend.diffGet(fx.sessionId)
    assert.ok(diffs.some((diff) => diff.path === 'tracked.txt' && diff.status === 'modified' && diff.additions === 1))
    assert.ok(diffs.some((diff) => diff.path === 'untracked.txt' && diff.status === 'added'))
    const modified = diffs.find((diff) => diff.path === 'tracked.txt')
    assert.equal(modified?.after, 'one\ntwo\n')
    assert.equal(modified?.before, 'one\n')

    await fx.backend.setProject(dir)
    const tree = await fx.backend.fileTree()
    assert.ok(tree.some((node) => node.path === 'tracked.txt'))
    assert.equal((await fx.backend.fileContent('tracked.txt')).content, 'one\ntwo\n')
  } finally {
    fx.cleanup()
  }
})

test('a thread tool call routes to the BOSS thread bus with the calling session attached', async () => {
  // The assistant asks who else is working, then reports. The bus tools only
  // exist once BOSS installs a handler, so this also covers the wiring.
  const fx = await bodyFixture((index) => {
    if (index === 0) {
      return (res) => {
        res.write(toolCallChunk({ id: 'bus-1', name: 'boss_threads_list', arguments: '{}' }))
        res.write(done())
        res.end()
      }
    }
    return (res) => {
      res.write(textChunk('Thread 2 is busy on the parser.'))
      res.write(done())
      res.end()
    }
  })
  try {
    const calls: Array<{ tool: string; nativeThreadId: string }> = []
    fx.backend.setThreadBusHandler(async (call) => {
      calls.push({ tool: call.tool, nativeThreadId: call.nativeThreadId })
      return [{ id: 'thread-2', title: 'parser', busy: true }]
    })
    await fx.backend.sendMessage(fx.sessionId, [{ type: 'text', text: 'who else is working?' }], { mode: 'auto' })

    assert.deepEqual(calls, [{ tool: 'boss_threads_list', nativeThreadId: fx.sessionId }])
    const parts = fx.readStore().messages(fx.sessionId).flatMap((message) => message.parts)
    const busPart = parts.find((part) => part.type === 'tool' && part.state?.tool === 'boss_threads_list')
    assert.ok(busPart, 'the bus call should be recorded as a tool part')
    assert.equal(busPart?.state?.status, 'completed')
    assert.match(String(busPart?.state?.output), /thread-2/)
  } finally {
    fx.cleanup()
  }
})
