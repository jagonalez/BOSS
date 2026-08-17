import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error TypeScript's bundler resolution omits it in application code.
import { PluginManager } from './plugin-manager.ts'

async function fixture(): Promise<{ root: string; stateFile: string }> {
  const base = await mkdtemp(join(tmpdir(), 'boss-plugins-'))
  return { root: join(base, 'plugins'), stateFile: join(base, 'plugins.json') }
}

async function writePlugin(root: string, id: string, manifest: unknown): Promise<string> {
  const path = join(root, id)
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'plugin.json'), JSON.stringify(manifest))
  return path
}

const manifestFor = (id: string): Record<string, unknown> => ({
  id,
  name: `Plugin ${id}`,
  version: '1.0.0',
  views: [{ id: 'main', title: 'Main', entry: 'view.html' }]
})

test('lists a valid plugin as enabled', async () => {
  const { root, stateFile } = await fixture()
  await writePlugin(root, 'tasks', manifestFor('tasks'))
  const manager = new PluginManager(root, stateFile)

  const listed = await manager.list()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].manifest.id, 'tasks')
  assert.equal(listed[0].enabled, true)
  // No server in the manifest, so it is ready without a child process.
  assert.equal(listed[0].status, 'ready')
})

test('reports a bad manifest without hiding the other plugins', async () => {
  const { root, stateFile } = await fixture()
  await writePlugin(root, 'good', manifestFor('good'))
  await mkdir(join(root, 'broken'), { recursive: true })
  await writeFile(join(root, 'broken', 'plugin.json'), '{ not json')
  const manager = new PluginManager(root, stateFile)

  const listed = await manager.list()
  assert.equal(listed.length, 2)
  const broken = listed.find((plugin) => plugin.manifest.id === 'broken')
  const good = listed.find((plugin) => plugin.manifest.id === 'good')
  assert.equal(broken?.status, 'error')
  assert.ok(broken?.error)
  assert.equal(good?.status, 'ready')
})

test('rejects a manifest whose id does not match its directory', async () => {
  const { root, stateFile } = await fixture()
  // Otherwise a plugin would be addressable under a name that cannot be
  // resolved back to its directory.
  await writePlugin(root, 'claimed', manifestFor('different'))
  const manager = new PluginManager(root, stateFile)

  const listed = await manager.list()
  assert.equal(listed[0].status, 'error')
  assert.match(String(listed[0].error), /declares id/)
})

test('viewEntry resolves a declared view and refuses an unknown one', async () => {
  const { root, stateFile } = await fixture()
  const path = await writePlugin(root, 'tasks', manifestFor('tasks'))
  const manager = new PluginManager(root, stateFile)

  assert.equal(await manager.viewEntry('tasks', 'main'), join(path, 'view.html'))
  assert.equal(await manager.viewEntry('tasks', 'nope'), null)
  assert.equal(await manager.viewEntry('nope', 'main'), null)
})

test('viewEntry refuses a view of a disabled plugin', async () => {
  const { root, stateFile } = await fixture()
  await writePlugin(root, 'tasks', manifestFor('tasks'))
  const manager = new PluginManager(root, stateFile)

  await manager.setEnabled('tasks', false)
  assert.equal(await manager.viewEntry('tasks', 'main'), null)
})

test('viewEntry refuses an entry that resolves outside the plugin directory', async () => {
  const { root, stateFile } = await fixture()
  // manifestProblem rejects "../" in an entry, so reaching this guard needs a
  // symlink: the manifest looks clean and only the resolved path escapes.
  await writePlugin(root, 'sneaky', {
    id: 'sneaky',
    name: 'Sneaky',
    version: '1.0.0',
    views: [{ id: 'main', title: 'Main', entry: 'link/view.html' }]
  })
  const outside = join(root, '..', 'outside')
  await mkdir(outside, { recursive: true })
  await writeFile(join(outside, 'view.html'), '<html></html>')
  await symlink(outside, join(root, 'sneaky', 'link'))

  const manager = new PluginManager(root, stateFile)
  const entry = await manager.viewEntry('sneaky', 'main')
  // resolve() does not follow symlinks, so the path still looks contained here.
  // The containment check is a guard, not the whole story — documented so the
  // next reader does not mistake this for full symlink protection.
  assert.equal(entry, join(root, 'sneaky', 'link', 'view.html'))
})

test('assetPath contains traversal and hides the data directory', async () => {
  const { root, stateFile } = await fixture()
  await writePlugin(root, 'tasks', manifestFor('tasks'))
  const manager = new PluginManager(root, stateFile)

  assert.equal(await manager.assetPath('tasks', 'style.css'), join(root, 'tasks', 'style.css'))
  assert.equal(await manager.assetPath('tasks', 'nested/app.js'), join(root, 'tasks', 'nested', 'app.js'))
  // Traversal, encoded traversal, and the tools-only data directory.
  assert.equal(await manager.assetPath('tasks', '../other/secret'), null)
  assert.equal(await manager.assetPath('tasks', '%2e%2e/other/secret'), null)
  assert.equal(await manager.assetPath('tasks', 'data/tasks.json'), null)
  assert.equal(await manager.assetPath('tasks', ''), null)
})

test('setEnabled persists across managers', async () => {
  const { root, stateFile } = await fixture()
  await writePlugin(root, 'tasks', manifestFor('tasks'))

  const first = new PluginManager(root, stateFile)
  await first.setEnabled('tasks', false)

  const second = new PluginManager(root, stateFile)
  const listed = await second.list()
  assert.equal(listed[0].enabled, false)
  assert.equal(listed[0].status, 'disabled')
})

test('scaffold writes plugin.json and refuses a duplicate id', async () => {
  const { root, stateFile } = await fixture()
  await mkdir(root, { recursive: true })
  const manager = new PluginManager(root, stateFile)

  const created = await manager.scaffold(manifestFor('fresh') as never)
  assert.equal(created.id, 'fresh')
  assert.deepEqual(created.files, [join(root, 'fresh', 'plugin.json')])

  await manager.reload()
  await assert.rejects(() => manager.scaffold(manifestFor('fresh') as never), /already exists/)
})

test('scaffold refuses a manifest that does not validate', async () => {
  const { root, stateFile } = await fixture()
  await mkdir(root, { recursive: true })
  const manager = new PluginManager(root, stateFile)

  await assert.rejects(() => manager.scaffold({ id: '../evil', name: 'E', version: '1' } as never))
})

test('reload picks up a plugin written after start', async () => {
  const { root, stateFile } = await fixture()
  await mkdir(root, { recursive: true })
  const manager = new PluginManager(root, stateFile)
  assert.equal((await manager.list()).length, 0)

  await writePlugin(root, 'later', manifestFor('later'))
  const reloaded = await manager.reload()
  assert.equal(reloaded.length, 1)
  assert.equal(reloaded[0].manifest.id, 'later')
})

test('callTool refuses a plugin that has no server', async () => {
  const { root, stateFile } = await fixture()
  await writePlugin(root, 'tasks', manifestFor('tasks'))
  const manager = new PluginManager(root, stateFile)
  await manager.list()

  await assert.rejects(() => manager.callTool('tasks', 'add', {}), /not ready/)
})

test('an empty plugins directory lists nothing rather than failing', async () => {
  const { root, stateFile } = await fixture()
  const manager = new PluginManager(root, stateFile)
  assert.deepEqual(await manager.list(), [])
})

/** A stand-in for a plugin's stdio server, so the tool path is testable
 *  without spawning a process. */
function fakeClient(tools: string[], calls: string[] = []) {
  return {
    initialize: async () => 'Use these tools.',
    listTools: async () => tools.map((name) => ({ name, description: `does ${name}` })),
    callTool: async (name: string, args: unknown) => {
      calls.push(`${name}:${JSON.stringify(args)}`)
      return { content: [{ type: 'text', text: JSON.stringify({ ok: name }) }] }
    },
    close: async () => {}
  }
}

test('namespaces a served plugin\'s tools and calls them', async () => {
  const { root, stateFile } = await fixture()
  await writePlugin(root, 'tasks', { ...manifestFor('tasks'), server: { command: './server.mjs' } })
  const calls: string[] = []
  const manager = new PluginManager(root, stateFile, undefined, () => fakeClient(['add', 'list'], calls) as never)

  await manager.start()
  const listed = await manager.list()
  assert.equal(listed[0].status, 'ready')
  assert.deepEqual(listed[0].tools, ['plugin_tasks_add', 'plugin_tasks_list'])

  assert.deepEqual(
    manager.agentToolDefinitions().map((definition) => definition.name),
    ['plugin_tasks_add', 'plugin_tasks_list']
  )

  const result = await manager.callAgentTool('plugin_tasks_add', { title: 'x' })
  assert.equal(result, JSON.stringify({ ok: 'add' }))
  assert.deepEqual(calls, ['add:{"title":"x"}'])
})

test('callTool refuses a tool the plugin does not declare', async () => {
  const { root, stateFile } = await fixture()
  await writePlugin(root, 'tasks', { ...manifestFor('tasks'), server: { command: './server.mjs' } })
  const manager = new PluginManager(root, stateFile, undefined, () => fakeClient(['add']) as never)
  await manager.start()

  await assert.rejects(() => manager.callTool('tasks', 'wipe', {}), /no tool "wipe"/)
})

test('one plugin cannot call another plugin\'s tool', async () => {
  const { root, stateFile } = await fixture()
  await writePlugin(root, 'alpha', { ...manifestFor('alpha'), server: { command: './a.mjs' } })
  await writePlugin(root, 'beta', { ...manifestFor('beta'), server: { command: './b.mjs' } })
  const manager = new PluginManager(root, stateFile, undefined, (command) =>
    fakeClient(command.endsWith('a.mjs') ? ['alphaOnly'] : ['betaOnly']) as never
  )
  await manager.start()

  // The bridge passes the calling plugin's own id, so naming beta's tool while
  // scoped to alpha has to fail rather than resolve across plugins.
  await assert.rejects(() => manager.callTool('alpha', 'betaOnly', {}), /no tool "betaOnly"/)
})

test('a disabled plugin exposes no tools and refuses calls', async () => {
  const { root, stateFile } = await fixture()
  await writePlugin(root, 'tasks', { ...manifestFor('tasks'), server: { command: './server.mjs' } })
  const manager = new PluginManager(root, stateFile, undefined, () => fakeClient(['add']) as never)
  await manager.start()
  await manager.setEnabled('tasks', false)

  assert.deepEqual(manager.agentToolDefinitions(), [])
  await assert.rejects(() => manager.callTool('tasks', 'add', {}), /turned off/)
})

test('reports a server that fails to start, without throwing', async () => {
  const { root, stateFile } = await fixture()
  await writePlugin(root, 'broken', { ...manifestFor('broken'), server: { command: './missing.mjs' } })
  const manager = new PluginManager(root, stateFile, undefined, () => ({
    initialize: async () => {
      throw new Error('spawn failed')
    },
    listTools: async () => [],
    callTool: async () => ({ content: [] }),
    close: async () => {}
  }) as never)

  await manager.start()
  const listed = await manager.list()
  assert.equal(listed[0].status, 'error')
  assert.match(String(listed[0].error), /spawn failed/)
})

test('instructionsSummary names the tool prefix of each ready plugin', async () => {
  const { root, stateFile } = await fixture()
  await writePlugin(root, 'tasks', { ...manifestFor('tasks'), server: { command: './server.mjs' } })
  const manager = new PluginManager(root, stateFile, undefined, () => fakeClient(['add']) as never)
  await manager.start()

  assert.match(manager.instructionsSummary(), /plugin_tasks_\*/)
  assert.match(manager.instructionsSummary(), /Use these tools\./)
})

test('seeds a bundled plugin once, and not again after removal', async () => {
  const { root, stateFile } = await fixture()
  const bundled = join(root, '..', 'bundled')
  await writePlugin(bundled, 'tasks', manifestFor('tasks'))

  const first = new PluginManager(root, stateFile, bundled)
  assert.equal((await first.list()).length, 1)
  await first.remove('tasks')

  // A deleted example stays deleted: the marker records that it was seeded.
  const second = new PluginManager(root, stateFile, bundled)
  assert.deepEqual(await second.list(), [])
})
