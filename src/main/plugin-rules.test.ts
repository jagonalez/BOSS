import assert from 'node:assert/strict'
import { test } from 'node:test'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error Application builds use bundler resolution.
import { manifestProblem, pluginToolName, validPluginId, validViewId } from './plugin-rules.ts'

const valid = {
  id: 'tasks',
  name: 'Tasks',
  version: '1.0.0',
  server: { command: './server.mjs' },
  views: [{ id: 'board', title: 'Tasks', entry: 'view.html' }]
}

test('accepts a well-formed manifest', () => {
  assert.equal(manifestProblem(valid), null)
})

test('accepts a manifest with no server or views', () => {
  assert.equal(manifestProblem({ id: 'bare', name: 'Bare', version: '0.1.0' }), null)
})

test('rejects a manifest that is not an object', () => {
  assert.match(String(manifestProblem(null)), /not an object/)
  assert.match(String(manifestProblem('tasks')), /not an object/)
})

test('rejects missing or malformed required fields', () => {
  assert.match(String(manifestProblem({ ...valid, id: undefined })), /needs an "id"/)
  assert.match(String(manifestProblem({ ...valid, name: '  ' })), /needs a "name"/)
  assert.match(String(manifestProblem({ ...valid, version: undefined })), /needs a "version"/)
})

test('rejects an id that could escape the plugins directory', () => {
  // The id is the directory name, so anything with a separator or a dot segment
  // would resolve somewhere else entirely.
  for (const id of ['../evil', 'a/b', '.hidden', 'Tasks', '', 'x'.repeat(64)]) {
    assert.notEqual(manifestProblem({ ...valid, id }), null, `expected ${JSON.stringify(id)} to be rejected`)
  }
})

test('rejects a view entry outside the plugin directory', () => {
  const escapes = ['../../etc/passwd', '/etc/passwd', 'nested/../../out']
  for (const entry of escapes) {
    const problem = manifestProblem({ ...valid, views: [{ id: 'board', title: 'T', entry }] })
    assert.match(String(problem), /outside the plugin directory/)
  }
})

test('rejects two views sharing an id', () => {
  const problem = manifestProblem({
    ...valid,
    views: [
      { id: 'board', title: 'One', entry: 'a.html' },
      { id: 'board', title: 'Two', entry: 'b.html' }
    ]
  })
  assert.match(String(problem), /share the id/)
})

test('rejects a server without a command', () => {
  assert.match(String(manifestProblem({ ...valid, server: {} })), /server.command/)
  assert.match(String(manifestProblem({ ...valid, server: { command: './x', args: 'no' } })), /server.args/)
})

test('rejects malformed views', () => {
  assert.match(String(manifestProblem({ ...valid, views: 'no' })), /"views" must be an array/)
  assert.match(String(manifestProblem({ ...valid, views: [{ id: 'a', entry: 'v.html' }] })), /needs a "title"/)
  assert.match(String(manifestProblem({ ...valid, views: [{ id: 'a', title: 'A' }] })), /needs an "entry"/)
})

test('validPluginId matches the directory-name rule', () => {
  assert.ok(validPluginId('tasks'))
  assert.ok(validPluginId('my-plugin-2'))
  assert.ok(!validPluginId('a'), 'a single character is too short to be meaningful')
  assert.ok(!validPluginId('2tasks'))
  assert.ok(!validPluginId('has_underscore'))
})

test('validViewId allows a single character but not an underscore', () => {
  // Views are namespaced by their plugin, so a one-letter id is unambiguous.
  assert.ok(validViewId('a'))
  assert.ok(!validViewId('has_underscore'))
})

test('pluginToolName namespaces by plugin id', () => {
  assert.equal(pluginToolName('tasks', 'add'), 'plugin_tasks_add')
})
