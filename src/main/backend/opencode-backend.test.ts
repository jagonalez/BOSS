import assert from 'node:assert/strict'
import test from 'node:test'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error Application code uses bundler resolution.
import { OpenCodeBackend } from './opencode-backend.ts'
import { createOpencodeClient } from '@opencode-ai/sdk'

/** A backend wired to a stub OpenCode server.
 *
 *  The backend talks to OpenCode through the generated SDK client, which uses
 *  fetch, so the stub is a fetch rather than an ApiClient. Requests are
 *  recorded as { path, directory } — the same shape the assertions used when
 *  this went through ApiClient — by reading them back off the URL. */
function harness(
  statuses: Record<string, { type: string }>,
  bodies: unknown[] = [],
  responses: Record<string, unknown> = {}
) {
  const requests: Array<{ path: string; directory?: string }> = []
  // The generated client calls fetch with a single Request and no init, so the
  // body is read off the Request rather than from an init argument.
  const fetchStub = async (input: Request | string | URL): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const directory = url.searchParams.get('directory') ?? undefined
    requests.push({ path: url.pathname, directory })
    if (input instanceof Request && input.body) {
      const text = await input.clone().text()
      if (text) bodies.push(JSON.parse(text))
    }
    const body = url.pathname === '/session/status'
      ? statuses
      : responses[url.pathname] ?? {}
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  }
  const events = { start() {}, stop() {}, onEvent: undefined as ((raw: string) => void) | undefined }
  const server = {
    start: async () => {}, stop: async () => {}, setProject: async () => {},
    info: { healthy: true }, projectPath: '/tmp/project',
    baseUrl: 'http://127.0.0.1:4096', authHeader: 'Bearer test'
  }
  const api = { async request() { return { status: 204, body: undefined } } }
  const backend = new OpenCodeBackend(server as never, api as never, events as never)
  // The SDK client takes its fetch at construction, so install the stub before
  // the first call builds it.
  ;(backend as unknown as { client?: unknown }).client = createOpencodeClient({
    baseUrl: server.baseUrl,
    fetch: fetchStub as typeof fetch,
    throwOnError: false
  })
  return { backend, requests }
}

test('every todo gets an id, even though the server sends none', async () => {
  // The SDK types declare Todo.id as required, but a real opencode server
  // returns only content, status and priority — verified with
  // scripts/probe-opencode-todos.mjs. The renderer keys the list by id, so
  // without a backfill every row keyed on undefined.
  const { backend } = harness({}, [], {
    '/session/ses_todo/todo': [
      { content: 'first', status: 'completed', priority: 'high' },
      { content: 'second', status: 'in_progress', priority: 'medium' }
    ]
  })

  const todos = await backend.todosGet('ses_todo')

  assert.equal(todos.length, 2)
  assert.ok(todos.every((todo) => Boolean(todo.id)), 'every todo needs a key of its own')
  assert.notEqual(todos[0].id, todos[1].id, 'two todos must not share a key')
  assert.deepEqual(todos.map((todo) => todo.status), ['completed', 'in_progress'])
})

test('a todo that arrives with an id keeps it', async () => {
  const { backend } = harness({}, [], {
    '/session/ses_todo/todo': [{ id: 'todo_real', content: 'first', status: 'pending' }]
  })

  const todos = await backend.todosGet('ses_todo')

  assert.equal(todos[0].id, 'todo_real')
})

test('status reconciliation clears a submitted run when OpenCode reports it idle', async () => {
  const { backend, requests } = harness({}, [], {
    '/session': { id: 'ses_worktree', directory: '/tmp/project' }
  })
  const received: unknown[] = []
  backend.onEvent((event) => received.push(event))
  // Created in the project root, then re-pointed at a worktree for its runs.
  await backend.sessionCreate('worktree thread', '/tmp/project/.boss/worktrees/wt')
  backend.setSessionDirectory('ses_worktree', '/tmp/project/.boss/worktrees/wt')
  await backend.sendMessage('ses_worktree', [{ type: 'text', text: 'test' }])

  const internal = backend as unknown as {
    submittedAt: Map<string, number>
    reconcileStatuses(): Promise<void>
  }
  internal.submittedAt.set('ses_worktree', Date.now() - 4_000)
  await internal.reconcileStatuses()

  // The poll has to ask about the scope the session is stored under. Asking
  // the worktree scope answered "nothing is running here" for a session that
  // was mid-run, and the synthetic idle marked the thread finished while it
  // was still working.
  assert.ok(requests.some((request) => request.path === '/session/status' && request.directory === '/tmp/project'))
  assert.deepEqual(received, [{ type: 'session.idle', sessionID: 'ses_worktree' }])
})

test('status reconciliation honors a busy answer from the stored scope, not the worktree', async () => {
  // The live failure this file's directory split exists for: the session's
  // records sit in the project root, its runs happen in a worktree, and only
  // the root scope knows the run is busy.
  const { backend } = harness(
    { ses_worktree: { type: 'busy' } },
    [],
    { '/session': { id: 'ses_worktree', directory: '/tmp/project' } }
  )
  const received: unknown[] = []
  backend.onEvent((event) => received.push(event))
  await backend.sessionCreate('worktree thread', '/tmp/project/.boss/worktrees/wt')
  backend.setSessionDirectory('ses_worktree', '/tmp/project/.boss/worktrees/wt')
  await backend.sendMessage('ses_worktree', [{ type: 'text', text: 'test' }])

  const internal = backend as unknown as { reconcileStatuses(): Promise<void> }
  await internal.reconcileStatuses()

  assert.deepEqual(received, [], 'a busy run must not be declared idle')
})

test('the todo list is read from the stored scope, or a worktree thread shows none', async () => {
  const { backend, requests } = harness({}, [], {
    '/session': { id: 'ses_mixed', directory: '/tmp/project' }
  })
  await backend.sessionCreate('worktree thread', '/tmp/project/.boss/worktrees/wt')
  backend.setSessionDirectory('ses_mixed', '/tmp/project/.boss/worktrees/wt')

  await backend.todosGet('ses_mixed')

  // publishTodosAfterToolCall re-reads the list the moment the agent writes
  // it; a read scoped to the worktree came back empty every time and the
  // thread's todo panel never filled in.
  const todo = requests.find((request) => request.path === '/session/ses_mixed/todo')
  assert.equal(todo?.directory, '/tmp/project')
})

test('stopping the server forgets which sessions it was running', async () => {
  // These record the server's state, not BOSS's. A restarted server is running
  // nothing, so a session left marked busy would show Working against a server
  // that had never heard of it.
  const { backend } = harness({})
  backend.setSessionDirectory('ses_worktree', '/tmp/worktree')
  await backend.sendMessage('ses_worktree', [{ type: 'text', text: 'test' }])

  const internal = backend as unknown as {
    observedStatuses: Map<string, string>
    submittedAt: Map<string, number>
    executionDirectories: Map<string, string>
  }
  assert.equal(internal.observedStatuses.get('ses_worktree'), 'busy')

  await backend.stop()

  assert.equal(internal.observedStatuses.size, 0)
  assert.equal(internal.submittedAt.size, 0)
  // Which checkout a session runs in is BOSS's own knowledge, and a restarted
  // server still needs telling.
  assert.equal(internal.executionDirectories.get('ses_worktree'), '/tmp/worktree')
})

test('status reconciliation preserves a run OpenCode still reports busy', async () => {
  const { backend } = harness({ ses_worktree: { type: 'busy' } })
  const received: unknown[] = []
  backend.onEvent((event) => received.push(event))
  backend.setSessionDirectory('ses_worktree', '/tmp/worktree')
  await backend.sendMessage('ses_worktree', [{ type: 'text', text: 'test' }])

  const internal = backend as unknown as { reconcileStatuses(): Promise<void> }
  await internal.reconcileStatuses()

  assert.deepEqual(received, [])
})

test('a read scopes to the checkout the session is stored under, not the last project selected', async () => {
  // Every read carries the session's own directory. Before this went through
  // the generated client, most calls sent none and OpenCode fell back to
  // whichever project the server had open — so a thread in a worktree could
  // read the wrong checkout.
  const { backend, requests } = harness({}, [], {
    '/session': { id: 'ses_worktree', directory: '/tmp/worktree' }
  })
  // A session created for a worktree is stored under the worktree's own
  // scope — OpenCode resolves the create directory, and the record answers
  // with where it filed it.
  await backend.sessionCreate('worktree thread', '/tmp/worktree')

  await backend.messagesList('ses_worktree')
  await backend.todosGet('ses_worktree')
  await backend.diffGet('ses_worktree')

  const scoped = requests.filter((request) => request.path.includes('ses_worktree'))
  assert.equal(scoped.length, 3)
  for (const request of scoped) assert.equal(request.directory, '/tmp/worktree')
})

test('a session re-pointed at a worktree keeps its records where they were created', async () => {
  // Runs execute in the worktree; reads still scope to the project root the
  // session was created under. Collapsing the two made every read of a
  // re-pointed thread miss — the todo list stayed empty and the status poll
  // invented an idle mid-run.
  const { backend, requests } = harness({}, [], {
    '/session': { id: 'ses_mixed', directory: '/tmp/project' }
  })
  await backend.sessionCreate('worktree thread', '/tmp/project/.boss/worktrees/wt')
  backend.setSessionDirectory('ses_mixed', '/tmp/project/.boss/worktrees/wt')

  await backend.sendMessage('ses_mixed', [{ type: 'text', text: 'test' }])
  await backend.runCommand('ses_mixed', '/review', '')

  const runs = requests.filter((request) => request.path === '/session/ses_mixed/prompt_async'
    || request.path === '/session/ses_mixed/command')
  assert.equal(runs.length, 2)
  for (const run of runs) assert.equal(run.directory, '/tmp/project/.boss/worktrees/wt')

  // The history read lands after the runs, so it is the last request — and it
  // goes to the root the session is stored under, not the worktree.
  await backend.messagesList('ses_mixed')
  assert.equal(requests.at(-1)?.directory, '/tmp/project')
})

test('a thread with no checkout of its own falls back to the current project', async () => {
  const { backend, requests } = harness({})

  await backend.messagesList('ses_plain')

  assert.equal(requests.at(-1)?.directory, '/tmp/project')
})

test('a slash command sends the model as a provider/model string', async () => {
  // This endpoint takes a string where prompt takes a { providerID, modelID }
  // object. The untyped client sent the object and OpenCode ignored it, so the
  // command silently ran on the default model.
  const bodies: unknown[] = []
  const { backend } = harness({}, bodies)

  await backend.runCommand('ses_worktree', '/test', 'args', {
    model: { providerID: 'anthropic', modelID: 'claude-opus-4-5' }
  })

  assert.equal((bodies.at(-1) as { model?: unknown })?.model, 'anthropic/claude-opus-4-5')
})

test('uses OpenCode’s small-model session title when it becomes available', async () => {
  const { backend } = harness({})
  backend.sessionGet = async (id) => ({ id, title: 'Improve automatic thread naming' })

  const title = await backend.generateTitle('ses_title', [], { currentTitle: 'Untitled thread' })

  assert.equal(title, 'Improve automatic thread naming')
})
