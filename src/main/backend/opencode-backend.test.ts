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
function harness(statuses: Record<string, { type: string }>, bodies: unknown[] = []) {
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
    const body = url.pathname === '/session/status' ? statuses : {}
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

test('status reconciliation clears a submitted run when OpenCode reports it idle', async () => {
  const { backend, requests } = harness({})
  const received: unknown[] = []
  backend.onEvent((event) => received.push(event))
  backend.setSessionDirectory('ses_worktree', '/tmp/worktree')
  await backend.sendMessage('ses_worktree', [{ type: 'text', text: 'test' }])

  const internal = backend as unknown as {
    submittedAt: Map<string, number>
    reconcileStatuses(): Promise<void>
  }
  internal.submittedAt.set('ses_worktree', Date.now() - 4_000)
  await internal.reconcileStatuses()

  assert.ok(requests.some((request) => request.path === '/session/status' && request.directory === '/tmp/worktree'))
  assert.deepEqual(received, [{ type: 'session.idle', sessionID: 'ses_worktree' }])
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
    sessionDirectories: Map<string, string>
  }
  assert.equal(internal.observedStatuses.get('ses_worktree'), 'busy')

  await backend.stop()

  assert.equal(internal.observedStatuses.size, 0)
  assert.equal(internal.submittedAt.size, 0)
  // Which checkout a session belongs to is BOSS's own knowledge, and a
  // restarted server still needs telling.
  assert.equal(internal.sessionDirectories.get('ses_worktree'), '/tmp/worktree')
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

test('a read scopes to the thread checkout, not the last project selected', async () => {
  // Every call carries the session's own directory. Before this went through
  // the generated client, most calls sent none and OpenCode fell back to
  // whichever project the server had open — so a thread in a worktree could
  // read the wrong checkout.
  const { backend, requests } = harness({})
  backend.setSessionDirectory('ses_worktree', '/tmp/worktree')

  await backend.messagesList('ses_worktree')
  await backend.todosGet('ses_worktree')
  await backend.diffGet('ses_worktree')

  const scoped = requests.filter((request) => request.path.includes('ses_worktree'))
  assert.equal(scoped.length, 3)
  for (const request of scoped) assert.equal(request.directory, '/tmp/worktree')
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
