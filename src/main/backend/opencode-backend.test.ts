import assert from 'node:assert/strict'
import test from 'node:test'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error Application code uses bundler resolution.
import { OpenCodeBackend } from './opencode-backend.ts'

function harness(statuses: Record<string, { type: string }>) {
  const requests: Array<{ path: string; directory?: string }> = []
  const api = {
    async request(request: { path: string; directory?: string }) {
      requests.push(request)
      if (request.path === '/session/status') return { status: 200, body: statuses }
      return { status: 204, body: undefined }
    }
  }
  const events = { start() {}, stop() {}, onEvent: undefined as ((raw: string) => void) | undefined }
  const server = {
    start: async () => {}, stop: async () => {}, setProject: async () => {},
    info: { healthy: true }, projectPath: '/tmp/project'
  }
  const backend = new OpenCodeBackend(server as never, api as never, events as never)
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
