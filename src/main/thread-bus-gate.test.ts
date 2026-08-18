import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

// ThreadBus cannot be imported here: it constructs with a parameter property,
// which Node's strip-only mode rejects, and it pulls in electron. The gate is
// still worth pinning, so these read the source the way the codex-backend
// tests do.
const source = readFileSync(join(import.meta.dirname, 'thread-bus.ts'), 'utf8')
const manager = readFileSync(join(import.meta.dirname, 'backend', 'manager.ts'), 'utf8')

test('the gate reads the calling thread’s project, never the app’s current one', () => {
  // Threads from several projects are open at once, so there is no single
  // "current project". Resolving the gate against one would deny agents in
  // every other project.
  const gate = source.slice(source.indexOf('private async runAgentCall('), source.indexOf('private async send('))
  assert.ok(gate.includes('this.policy(caller.projectId)'), 'the gate should key on the caller’s project')
  assert.ok(!gate.includes('currentScope'), 'the gate must not consult the app’s current project')
})

test('every backend reaches the gate through one call', () => {
  // The denial was reported for Claude, but nothing here is backend-specific:
  // codex arrives via setThreadBusHandler, opencode and pi via the HTTP
  // endpoint, and claude via the MCP bridge. All three land on agentCall.
  const entryPoints = source.split('this.agentCall(').length - 1
  assert.equal(entryPoints, 2, 'the HTTP endpoint and the MCP bridge should both call agentCall')
  assert.ok(manager.includes('threadBus.agentCall(backend.id'), 'backends with a handler should call agentCall')

  const gate = source.slice(source.indexOf('private async runAgentCall('), source.indexOf('private async send('))
  for (const backendId of ['claude', 'codex', 'opencode', 'pi']) {
    assert.ok(!gate.includes(`'${backendId}'`), `the gate should not special-case ${backendId}`)
  }
})

test('the policy the gate reads is the one the tests cover', () => {
  // collaboration-policy.test.ts pins the default-and-override behaviour, but
  // only if this is the code that runs. A private fallback here would restore
  // the old hardcoded 'off' without failing a single test.
  const start = source.indexOf('policy(projectId: string)')
  const policy = source.slice(start, source.indexOf('setPolicy(', start))
  assert.ok(policy.length > 0, 'expected to find the policy() method')
  assert.ok(policy.includes('resolvePolicy('), 'policy() should defer to the shared resolver')
  assert.ok(!policy.includes("?? 'off'"), 'policy() must not hardcode a fallback of its own')
})

test('setting a project policy names the project outright', () => {
  // The bug: the handler fell back to the app's current project, so the
  // policy landed on whichever project was opened last.
  const handler = manager.slice(
    manager.indexOf("case 'thread.bus.policy':"),
    manager.indexOf("case 'thread.bus.default-policy':")
  )
  assert.ok(handler.includes('request.projectId'), 'the request should carry the target project')
  assert.ok(!handler.includes('this.currentScope'), 'setting a project policy must not use the current project')
})
