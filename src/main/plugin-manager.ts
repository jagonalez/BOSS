import { cp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type { BackendRequest } from '../shared/backend'
import type { PluginManifest, PluginProject, PluginScaffold, PluginStatus, PluginView } from '../shared/plugin'
// The explicit extension keeps the source executable under Node's type-stripping test runner.
// @ts-expect-error Application builds use bundler resolution.
import { PLUGIN_TOOL_PREFIX, manifestProblem, pluginToolName, validPluginId } from './plugin-rules.ts'
import type { McpClient, McpToolDefinition } from './mcp-client'

/** How a plugin's stdio server is started. Injected rather than imported so
 *  this class stays loadable under Node's type-stripping test runner, which
 *  cannot parse mcp-client's parameter properties. */
export type PluginClientFactory = (
  command: string,
  args: string[],
  env: Record<string, string>
) => McpClient

/** Where the current project comes from. Injected rather than reaching into
 *  BackendManager, which would couple this class to the backend and make it
 *  untestable. */
export type PluginProjectSource = () => PluginProject

interface LivePlugin {
  client: McpClient
  tools: McpToolDefinition[]
  instructions?: string
}

interface LoadedPlugin {
  manifest: PluginManifest
  path: string
  status: PluginStatus
  error?: string
}

interface PluginState {
  version: 1
  /** Ids the user turned off. Absent means enabled: a plugin the agent just
   *  wrote should work without a second step. */
  disabled: string[]
  /** Bundled plugins already copied in. Recorded so deleting one keeps it
   *  deleted rather than having it reappear on the next launch. */
  seeded?: string[]
}

/**
 * Loads plugin directories, connects their MCP servers and reports what they
 * offer. It deliberately mirrors McpHub rather than extending it: a plugin is
 * discovered from disk and removed by deleting a directory, while an MCP
 * connection is typed in and persisted. Sharing one class would mean every
 * method asking which kind it held.
 */
export class PluginManager {
  private loaded = false
  private plugins: LoadedPlugin[] = []
  private readonly live = new Map<string, LivePlugin>()
  private disabled = new Set<string>()
  private seeded = new Set<string>()
  private onChange?: () => void

  /** Directory holding one subdirectory per plugin. */
  private readonly root: string
  /** Where the enabled/disabled choice persists. */
  private readonly stateFile: string
  /** Bundled example plugins, copied in on first run only. */
  private readonly bundledRoot?: string
  private readonly createClient?: PluginClientFactory
  private readonly projectSource?: PluginProjectSource

  // Assigned in the body rather than declared as parameter properties: Node's
  // type-stripping test runner cannot parse those, and this class has tests.
  constructor(
    root: string,
    stateFile: string,
    bundledRoot?: string,
    createClient?: PluginClientFactory,
    projectSource?: PluginProjectSource
  ) {
    this.root = root
    this.stateFile = stateFile
    this.bundledRoot = bundledRoot
    this.createClient = createClient
    this.projectSource = projectSource
  }

  /** The project a call is being made for. Falls back to global, which is also
   *  what BOSS reports when no project is open, so a plugin never has to handle
   *  a missing value. */
  private project(): PluginProject {
    try {
      return this.projectSource?.() ?? { projectId: 'global', projectPath: '' }
    } catch {
      return { projectId: 'global', projectPath: '' }
    }
  }

  /**
   * Copy the plugins BOSS ships into the user's plugins directory, once each.
   * Copied rather than loaded in place so the user can read one as a worked
   * example, edit it, or delete it — and a deleted one stays deleted, which is
   * why the marker records the attempt rather than checking the directory.
   */
  private async seedBundled(): Promise<void> {
    if (!this.bundledRoot) return
    let names: string[] = []
    try {
      const dirents = await readdir(this.bundledRoot, { withFileTypes: true })
      names = dirents.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    } catch {
      return
    }
    let changed = false
    for (const name of names) {
      if (this.seeded.has(name)) continue
      this.seeded.add(name)
      changed = true
      try {
        await cp(join(this.bundledRoot, name), join(this.root, name), {
          recursive: true,
          errorOnExist: true,
          force: false
        })
      } catch {
        /* Already there, or unreadable. Either way it is not seeded again. */
      }
    }
    if (changed) await this.saveState()
  }

  setOnChange(callback: () => void): void {
    this.onChange = callback
  }

  private notifyChange(): void {
    this.onChange?.()
  }

  private async loadState(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.stateFile, 'utf8')) as Partial<PluginState>
      if (parsed.version === 1) {
        if (Array.isArray(parsed.disabled)) this.disabled = new Set(parsed.disabled)
        if (Array.isArray(parsed.seeded)) this.seeded = new Set(parsed.seeded)
      }
    } catch {
      /* First launch has every discovered plugin enabled. */
    }
  }

  private async saveState(): Promise<void> {
    await mkdir(dirname(this.stateFile), { recursive: true })
    const state: PluginState = {
      version: 1,
      disabled: [...this.disabled],
      seeded: [...this.seeded]
    }
    await writeFile(this.stateFile, JSON.stringify(state, null, 2))
  }

  /** Read every plugin directory. One bad manifest is reported, not fatal. */
  private async scan(): Promise<void> {
    this.plugins = []
    let entries: string[] = []
    try {
      const dirents = await readdir(this.root, { withFileTypes: true })
      entries = dirents.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    } catch {
      return // No plugins directory yet.
    }
    for (const name of entries.sort()) {
      const path = join(this.root, name)
      let manifest: PluginManifest
      try {
        const parsed = JSON.parse(await readFile(join(path, 'plugin.json'), 'utf8')) as unknown
        const problem = manifestProblem(parsed)
        if (problem) {
          this.plugins.push({
            manifest: { id: name, name, version: '0.0.0' },
            path,
            status: 'error',
            error: problem
          })
          continue
        }
        manifest = parsed as PluginManifest
      } catch (error) {
        this.plugins.push({
          manifest: { id: name, name, version: '0.0.0' },
          path,
          status: 'error',
          error: error instanceof Error ? error.message : String(error)
        })
        continue
      }
      // The directory name is the address the view bridge and tool names use,
      // so a manifest claiming a different id would make a plugin reachable
      // under a name that does not resolve back to it.
      if (manifest.id !== name) {
        this.plugins.push({
          manifest,
          path,
          status: 'error',
          error: `plugin.json declares id "${manifest.id}" but the directory is named "${name}".`
        })
        continue
      }
      // A view-only plugin has no server to wait for, so it is ready as soon as
      // it is read. Only a plugin with a server passes through 'loading'.
      const status: PluginStatus = this.disabled.has(manifest.id)
        ? 'disabled'
        : manifest.server
          ? 'loading'
          : 'ready'
      this.plugins.push({ manifest, path, status })
    }
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    await this.loadState()
    await this.seedBundled()
    await this.scan()
  }

  /**
   * Connect every enabled plugin that has a server. Awaited to completion, and
   * in parallel: one slow plugin must not hold up the others, and connect()
   * records a failure on the plugin rather than throwing, so a broken plugin
   * cannot stop the rest from starting.
   */
  async start(): Promise<void> {
    await this.load()
    await Promise.all(
      this.plugins.filter((plugin) => plugin.status === 'loading').map((plugin) => this.connect(plugin))
    )
  }

  async stop(): Promise<void> {
    for (const [id, live] of [...this.live]) {
      this.live.delete(id)
      await live.client.close().catch(() => {})
    }
  }

  private async connect(plugin: LoadedPlugin): Promise<void> {
    const existing = this.live.get(plugin.manifest.id)
    if (existing) {
      this.live.delete(plugin.manifest.id)
      await existing.client.close().catch(() => {})
    }
    const server = plugin.manifest.server
    if (!server) {
      // A view-only plugin is legitimate: it renders something without tools.
      plugin.status = 'ready'
      this.notifyChange()
      return
    }
    plugin.status = 'loading'
    plugin.error = undefined
    this.notifyChange()
    // A relative command means a file the plugin shipped. Resolving it here
    // rather than trusting cwd keeps the spawn independent of BOSS's own
    // working directory, which changes with the focused worktree.
    const command = server.command.includes('/') ? resolve(plugin.path, server.command) : server.command
    const args = (server.args ?? []).map((arg) =>
      arg.startsWith('./') || arg.startsWith('../') ? resolve(plugin.path, arg) : arg
    )
    if (!this.createClient) {
      plugin.status = 'error'
      plugin.error = 'This BOSS build cannot start plugin servers.'
      this.notifyChange()
      return
    }
    const client = this.createClient(command, args, {
      ...(server.env ?? {}),
      // Its own directory, so a plugin stores data without guessing a path.
      BOSS_PLUGIN_DIR: plugin.path,
      BOSS_PLUGIN_DATA_DIR: join(plugin.path, 'data')
    })
    try {
      await mkdir(join(plugin.path, 'data'), { recursive: true })
      const instructions = await client.initialize()
      const tools = await client.listTools()
      this.live.set(plugin.manifest.id, { client, tools, instructions })
      plugin.status = 'ready'
    } catch (error) {
      await client.close().catch(() => {})
      plugin.status = 'error'
      plugin.error = error instanceof Error ? error.message : String(error)
    }
    this.notifyChange()
  }

  private async disconnect(id: string): Promise<void> {
    const live = this.live.get(id)
    this.live.delete(id)
    if (live) await live.client.close().catch(() => {})
    this.notifyChange()
  }

  private view(plugin: LoadedPlugin): PluginView {
    const live = this.live.get(plugin.manifest.id)
    return {
      manifest: plugin.manifest,
      path: plugin.path,
      enabled: !this.disabled.has(plugin.manifest.id),
      status: plugin.status,
      error: plugin.error,
      tools: (live?.tools ?? []).map((tool) => pluginToolName(plugin.manifest.id, tool.name))
    }
  }

  async list(): Promise<PluginView[]> {
    await this.load()
    return this.plugins.map((plugin) => this.view(plugin))
  }

  /** Re-read the directory so an agent's new plugin appears without a restart. */
  async reload(): Promise<PluginView[]> {
    await this.load()
    const previous = new Map(this.plugins.map((plugin) => [plugin.manifest.id, plugin]))
    await this.scan()
    // Drop servers whose plugin disappeared or whose manifest changed; a stale
    // child process would keep answering tool calls for a plugin that is gone.
    for (const id of [...this.live.keys()]) {
      const still = this.plugins.find((plugin) => plugin.manifest.id === id)
      const before = previous.get(id)
      const changed = !still || JSON.stringify(still.manifest.server) !== JSON.stringify(before?.manifest.server)
      if (changed) await this.disconnect(id)
    }
    const connecting: Array<Promise<void>> = []
    for (const plugin of this.plugins) {
      if (this.disabled.has(plugin.manifest.id)) continue
      if (this.live.has(plugin.manifest.id)) plugin.status = 'ready'
      else if (plugin.status === 'loading') connecting.push(this.connect(plugin))
    }
    // Awaited so the returned list reflects what actually started. The agent
    // calls reload right after writing a plugin and reads this to check it.
    await Promise.all(connecting)
    this.notifyChange()
    return this.plugins.map((plugin) => this.view(plugin))
  }

  async setEnabled(id: string, enabled: boolean): Promise<PluginView[]> {
    await this.load()
    const plugin = this.plugins.find((item) => item.manifest.id === id)
    if (!plugin) throw new Error(`Unknown plugin "${id}".`)
    if (enabled) this.disabled.delete(id)
    else this.disabled.add(id)
    await this.saveState()
    if (enabled) {
      await this.connect(plugin)
    } else {
      await this.disconnect(id)
      plugin.status = 'disabled'
      plugin.error = undefined
    }
    this.notifyChange()
    return this.plugins.map((item) => this.view(item))
  }

  async remove(id: string): Promise<PluginView[]> {
    await this.load()
    const plugin = this.plugins.find((item) => item.manifest.id === id)
    if (!plugin) throw new Error(`Unknown plugin "${id}".`)
    await this.disconnect(id)
    await rm(plugin.path, { recursive: true, force: true })
    this.disabled.delete(id)
    await this.saveState()
    await this.scan()
    this.notifyChange()
    return this.plugins.map((item) => this.view(item))
  }

  /**
   * Absolute path of a view's entry file, or null when the plugin, the view or
   * the file is not usable. Resolved and then checked against the plugin
   * directory: manifestProblem already rejects the obvious escapes, but a
   * symlink or an odd separator only shows up once the path is real.
   */
  async viewEntry(pluginId: string, viewId: string): Promise<string | null> {
    await this.load()
    const plugin = this.plugins.find((item) => item.manifest.id === pluginId)
    if (!plugin || this.disabled.has(pluginId)) return null
    const view = plugin.manifest.views?.find((item) => item.id === viewId)
    if (!view) return null
    const entry = resolve(plugin.path, view.entry)
    const base = resolve(plugin.path)
    if (entry !== base && !entry.startsWith(base + sep)) return null
    return entry
  }

  /**
   * Absolute path of a file a view referenced, or null when it is outside the
   * plugin directory. Same containment check as viewEntry: the request arrives
   * as a URL path, so ".." and an absolute-looking segment both have to fail
   * before the file is read.
   */
  async assetPath(pluginId: string, relativePath: string): Promise<string | null> {
    await this.load()
    const plugin = this.plugins.find((item) => item.manifest.id === pluginId)
    if (!plugin || this.disabled.has(pluginId)) return null
    const decoded = (() => {
      try {
        return decodeURIComponent(relativePath)
      } catch {
        return null
      }
    })()
    if (decoded === null || decoded.includes('\0')) return null
    const target = resolve(plugin.path, decoded)
    const base = resolve(plugin.path)
    if (!target.startsWith(base + sep)) return null
    // Its own data directory holds whatever the plugin's tools wrote. Serving
    // it to the page would hand the view a read path that bypasses the tools.
    if (target.startsWith(resolve(plugin.path, 'data') + sep)) return null
    return target
  }

  /** Tool definitions for agents, namespaced plugin_<id>_<tool>. */
  agentToolDefinitions(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
    const definitions: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = []
    for (const plugin of this.plugins) {
      const live = this.live.get(plugin.manifest.id)
      if (this.disabled.has(plugin.manifest.id) || !live) continue
      for (const tool of live.tools) {
        definitions.push({
          name: pluginToolName(plugin.manifest.id, tool.name),
          description: `[${plugin.manifest.name}] ${tool.description ?? tool.name}`.slice(0, 1_000),
          // The agent is not told about "project": BOSS sets it on every call,
          // so advertising it would invite the model to pass a project of its
          // own choosing and defeat the point.
          inputSchema: tool.inputSchema ?? { type: 'object', additionalProperties: true }
        })
      }
    }
    return definitions
  }

  /**
   * Call a tool on one plugin's server. `pluginId` is supplied by the caller
   * rather than parsed out of the name, because the view bridge knows which
   * plugin it is serving and must not be able to reach another one. Splitting a
   * flat name on the first underscore could not tell "plugin a, tool b_c" from
   * "plugin a_b, tool c".
   */
  async callTool(pluginId: string, toolName: string, args: unknown): Promise<string> {
    await this.load()
    if (this.disabled.has(pluginId)) throw new Error(`The "${pluginId}" plugin is turned off.`)
    const live = this.live.get(pluginId)
    if (!live) throw new Error(`The "${pluginId}" plugin is not ready.`)
    if (!live.tools.some((tool) => tool.name === toolName)) {
      throw new Error(`The "${pluginId}" plugin has no tool "${toolName}".`)
    }
    // BOSS supplies the project, on every call, from the agent and from a view
    // alike. Neither caller has to know or agree — which is the point: a plugin
    // storing per project cannot end up with its two halves in different ones.
    // Set last so a caller cannot spoof it by passing its own "project".
    const withProject = {
      ...(args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {}),
      project: this.project()
    }
    const result = await live.client.callTool(toolName, withProject)
    const text = result.content
      .map((item) => (typeof item.text === 'string' ? item.text : JSON.stringify(item)))
      .filter(Boolean)
      .join('\n')
    if (result.isError) throw new Error(text || 'The plugin tool reported an error.')
    return text || '(empty result)'
  }

  /** Resolve a namespaced agent tool name and call it. */
  async callAgentTool(namespacedName: string, args: unknown): Promise<string> {
    await this.load()
    const name = namespacedName.startsWith(PLUGIN_TOOL_PREFIX)
      ? namespacedName.slice(PLUGIN_TOOL_PREFIX.length)
      : namespacedName
    for (const plugin of this.plugins) {
      const id = plugin.manifest.id
      if (this.disabled.has(id) || !name.startsWith(`${id}_`)) continue
      const toolName = name.slice(id.length + 1)
      const live = this.live.get(id)
      if (!live?.tools.some((tool) => tool.name === toolName)) continue
      return this.callTool(id, toolName, args)
    }
    throw new Error(`Unknown plugin tool: ${namespacedName}. Use boss_plugin_list to see what is available.`)
  }

  /** Listing for the boss_plugin_list agent tool. */
  agentListing(): unknown {
    return this.plugins.map((plugin) => {
      const live = this.live.get(plugin.manifest.id)
      return {
        id: plugin.manifest.id,
        name: plugin.manifest.name,
        version: plugin.manifest.version,
        description: plugin.manifest.description,
        status: this.disabled.has(plugin.manifest.id) ? 'disabled' : plugin.status,
        error: plugin.error,
        instructions: live?.instructions,
        views: (plugin.manifest.views ?? []).map((view) => ({ id: view.id, title: view.title })),
        tools: (live?.tools ?? []).map((tool) => ({
          tool: pluginToolName(plugin.manifest.id, tool.name),
          description: (tool.description ?? '').slice(0, 200),
          inputSchema: tool.inputSchema ?? { type: 'object', additionalProperties: true }
        }))
      }
    })
  }

  /** Server instructions of ready plugins, for backends that surface them. */
  instructionsSummary(): string {
    const parts: string[] = []
    for (const plugin of this.plugins) {
      const live = this.live.get(plugin.manifest.id)
      if (this.disabled.has(plugin.manifest.id) || !live?.instructions) continue
      parts.push(`## ${plugin.manifest.name} (tools ${PLUGIN_TOOL_PREFIX}${plugin.manifest.id}_*)\n${live.instructions}`)
    }
    return parts.join('\n\n')
  }

  /**
   * Create the directory for a plugin the agent is about to write. It writes
   * only plugin.json: the agent has file tools and writes better code than a
   * template, so a scaffold that guessed at server.js would mostly be deleted.
   */
  async scaffold(manifest: PluginManifest): Promise<PluginScaffold> {
    await this.load()
    const problem = manifestProblem(manifest)
    if (problem) throw new Error(problem)
    if (!validPluginId(manifest.id)) throw new Error(`"${manifest.id}" is not a usable plugin id.`)
    const path = join(this.root, manifest.id)
    if (this.plugins.some((plugin) => plugin.manifest.id === manifest.id)) {
      throw new Error(`A plugin with the id "${manifest.id}" already exists at ${path}.`)
    }
    await mkdir(join(path, 'data'), { recursive: true })
    const manifestPath = join(path, 'plugin.json')
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    return { id: manifest.id, path, files: [manifestPath] }
  }

  /** Where plugins live, so agent tools can tell the model where to write. */
  directory(): string {
    return this.root
  }

  async handle(request: BackendRequest): Promise<unknown> {
    switch (request.type) {
      case 'plugin.list': return this.list()
      case 'plugin.reload': return this.reload()
      case 'plugin.setEnabled': return this.setEnabled(request.pluginId, request.enabled)
      case 'plugin.remove': return this.remove(request.pluginId)
      case 'plugin.call': return this.callTool(request.pluginId, request.tool, request.args)
      default: throw new Error(`Unsupported plugin request: ${request.type}`)
    }
  }
}
