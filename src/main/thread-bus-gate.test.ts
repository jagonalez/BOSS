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

test('opening a change request is answered before the collaboration gate', () => {
  // The gate governs one thread reaching another. Opening a pull or merge request acts on the
  // caller's own checkout, so a project with collaboration off must still be able to do it.
  const gate = source.slice(source.indexOf('private async runAgentCall('), source.indexOf('private async send('))
  const tool = gate.indexOf("tool === 'boss_git_create_change_request'")
  const policy = gate.indexOf("if (policy === 'off')")
  assert.ok(tool > 0, 'expected the change request tool to be dispatched in runAgentCall')
  assert.ok(policy > 0, 'expected to find the collaboration gate')
  assert.ok(tool < policy, 'the change request tool must be answered before the collaboration gate')
})

test('a change request is opened for the caller’s own checkout', () => {
  // A thread on a worktree must open the request for that worktree's branch, not for whatever the
  // project directory happens to have checked out.
  const gate = source.slice(source.indexOf("tool === 'boss_git_create_change_request'"), source.indexOf("const policy = this.policy("))
  assert.ok(gate.includes('caller.executionPath'), 'expected the caller’s execution path')
  assert.ok(!gate.includes('projectPath'), 'the project path is not where the thread is working')
})

test('every agent backend registers the change request tool', () => {
  // Each backend registers its own tool list, so a tool added only to the bus reaches no model.
  // Keep this exhaustive: Lab has no MCP client and was previously omitted
  // even though its built-in git_commit made it otherwise capable of the same
  // commit -> host publish -> change request workflow.
  for (const file of [
    join(import.meta.dirname, 'backend', 'claude-backend.ts'),
    join(import.meta.dirname, 'backend', 'codex-backend.ts'),
    join(import.meta.dirname, 'backend', 'pi-backend.ts'),
    join(import.meta.dirname, 'opencode-server.ts'),
    join(import.meta.dirname, 'backend', 'lab-thread-tools.ts')
  ]) {
    const backend = readFileSync(file, 'utf8')
    assert.ok(
      backend.includes('boss_git_create_change_request'),
      `${file} should register the shared change request tool`
    )
  }
})
