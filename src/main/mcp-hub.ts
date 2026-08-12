import { safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type {
  McpConnection,
  McpConnectionInput,
  McpConnectionStatus,
  McpConnectionView,
  McpImportCandidate
} from '../shared/mcp'
import { MCP_TOOL_PREFIX, SECRET_MASK } from '../shared/mcp'
import type { BackendRequest } from '../shared/backend'
import { HttpMcpClient, StdioMcpClient, type McpClient, type McpToolDefinition } from './mcp-client'

interface StoredConnection extends Omit<McpConnection, 'env' | 'headers'> {
  /** Secret maps are stored value-encrypted: { KEY: <base64 ciphertext> }. */
  env?: Record<string, string>
  headers?: Record<string, string>
  secretsEncrypted: boolean
}

interface HubState {
  version: 1
  connections: StoredConnection[]
}

interface LiveConnection {
  client: McpClient
  tools: McpToolDefinition[]
}

function slugify(name: string): string {
  const clean = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24)
  return clean || 'server'
}

function encryptValues(values: Record<string, string> | undefined, available: boolean): Record<string, string> | undefined {
  if (!values) return undefined
  if (!available) return { ...values }
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, safeStorage.encryptString(value).toString('base64')])
  )
}

function decryptValues(values: Record<string, string> | undefined, encrypted: boolean): Record<string, string> {
  if (!values) return {}
  if (!encrypted) return { ...values }
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(values)) {
    try {
      result[key] = safeStorage.decryptString(Buffer.from(value, 'base64'))
    } catch {
      /* An undecryptable secret is dropped rather than sent as ciphertext. */
    }
  }
  return result
}

function maskValues(values: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!values) return undefined
  return Object.fromEntries(Object.keys(values).map((key) => [key, SECRET_MASK]))
}

/** Minimal TOML reader for codex config: [mcp_servers.<name>] tables with string/array values. */
function codexMcpServers(toml: string): Array<{ name: string; values: Record<string, string | string[]> }> {
  const servers: Array<{ name: string; values: Record<string, string | string[]> }> = []
  let current: { name: string; values: Record<string, string | string[]> } | null = null
  for (const rawLine of toml.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const table = /^\[([^\]]+)\]$/.exec(line)
    if (table) {
      const match = /^mcp_servers\.(.+)$/.exec(table[1].trim())
      current = match ? { name: match[1].replace(/^"|"$/g, ''), values: {} } : null
      if (current) servers.push(current)
      continue
    }
    if (!current) continue
    const pair = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line)
    if (!pair) continue
    const [, key, rawValue] = pair
    if (rawValue.startsWith('[')) {
      const items = [...rawValue.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1])
      current.values[key] = items
    } else {
      const text = /^"((?:[^"\\]|\\.)*)"$/.exec(rawValue)
      current.values[key] = text ? text[1] : rawValue
    }
  }
  return servers
}

export class McpHub {
  private loaded = false
  private connections: StoredConnection[] = []
  private readonly live = new Map<string, LiveConnection>()
  private readonly status = new Map<string, { status: McpConnectionStatus; error?: string }>()
  private onChange?: () => void

  constructor(private readonly stateFile: string) {}

  setOnChange(callback: () => void): void {
    this.onChange = callback
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed = JSON.parse(await readFile(this.stateFile, 'utf8')) as Partial<HubState>
      if (parsed.version === 1 && Array.isArray(parsed.connections)) this.connections = parsed.connections
    } catch {
      /* First launch starts with no MCP connections. */
    }
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.stateFile), { recursive: true })
    const state: HubState = { version: 1, connections: this.connections }
    await writeFile(this.stateFile, JSON.stringify(state, null, 2))
  }

  private notifyChange(): void {
    this.onChange?.()
  }

  async start(): Promise<void> {
    await this.load()
    for (const connection of this.connections) {
      if (connection.enabled) void this.connect(connection)
    }
  }

  async stop(): Promise<void> {
    for (const [id, live] of [...this.live]) {
      this.live.delete(id)
      await live.client.close().catch(() => {})
    }
  }

  private connectionSecrets(connection: StoredConnection): { env: Record<string, string>; headers: Record<string, string> } {
    return {
      env: decryptValues(connection.env, connection.secretsEncrypted),
      headers: decryptValues(connection.headers, connection.secretsEncrypted)
    }
  }

  private async connect(connection: StoredConnection): Promise<void> {
    const existing = this.live.get(connection.id)
    if (existing) {
      this.live.delete(connection.id)
      await existing.client.close().catch(() => {})
    }
    this.status.set(connection.id, { status: 'starting' })
    this.notifyChange()
    const secrets = this.connectionSecrets(connection)
    const client: McpClient = connection.transport === 'stdio'
      ? new StdioMcpClient(connection.command ?? '', connection.args ?? [], secrets.env)
      : new HttpMcpClient(connection.url ?? '', secrets.headers)
    try {
      await client.initialize()
      const tools = await client.listTools()
      this.live.set(connection.id, { client, tools })
      this.status.set(connection.id, { status: 'connected' })
    } catch (error) {
      await client.close().catch(() => {})
      this.status.set(connection.id, {
        status: 'error',
        error: error instanceof Error ? error.message : String(error)
      })
    }
    this.notifyChange()
  }

  private async disconnect(id: string): Promise<void> {
    const live = this.live.get(id)
    this.live.delete(id)
    this.status.set(id, { status: 'disabled' })
    if (live) await live.client.close().catch(() => {})
    this.notifyChange()
  }

  private view(connection: StoredConnection): McpConnectionView {
    const state = this.status.get(connection.id) ?? { status: connection.enabled ? 'starting' : 'disabled' as McpConnectionStatus }
    const live = this.live.get(connection.id)
    return {
      connection: {
        ...connection,
        env: maskValues(connection.env),
        headers: maskValues(connection.headers)
      },
      status: state.status,
      error: state.error,
      tools: (live?.tools ?? []).map((tool) => ({ name: tool.name, description: tool.description }))
    }
  }

  async list(): Promise<McpConnectionView[]> {
    await this.load()
    return this.connections.map((connection) => this.view(connection))
  }

  private normalizeInput(input: McpConnectionInput): McpConnectionInput {
    const name = input.name.trim()
    if (!name) throw new Error('Give the connection a name.')
    if (input.transport === 'stdio') {
      if (!input.command?.trim()) throw new Error('A stdio connection needs a command.')
    } else if (!/^https?:\/\//.test(input.url ?? '')) {
      throw new Error('An HTTP connection needs an http(s) URL.')
    }
    return { ...input, name }
  }

  /** Merge masked secret values from the renderer with the stored ciphertext. */
  private mergeSecrets(
    incoming: Record<string, string> | undefined,
    stored: Record<string, string> | undefined,
    storedEncrypted: boolean,
    available: boolean
  ): Record<string, string> | undefined {
    if (!incoming) return undefined
    const storedPlain = decryptValues(stored, storedEncrypted)
    const merged: Record<string, string> = {}
    for (const [key, value] of Object.entries(incoming)) {
      merged[key] = value === SECRET_MASK ? storedPlain[key] ?? '' : value
    }
    return encryptValues(merged, available)
  }

  async add(input: McpConnectionInput): Promise<McpConnectionView> {
    await this.load()
    const clean = this.normalizeInput(input)
    const available = safeStorage.isEncryptionAvailable()
    const base = slugify(clean.name)
    let slug = base
    let suffix = 2
    while (this.connections.some((connection) => connection.slug === slug)) slug = `${base}_${suffix++}`
    const connection: StoredConnection = {
      ...clean,
      env: encryptValues(clean.env, available),
      headers: encryptValues(clean.headers, available),
      secretsEncrypted: available,
      id: randomUUID(),
      slug,
      enabled: true,
      createdAt: Date.now()
    }
    this.connections.push(connection)
    await this.save()
    void this.connect(connection)
    return this.view(connection)
  }

  async update(id: string, patch: Partial<McpConnectionInput> & { enabled?: boolean }): Promise<McpConnectionView> {
    await this.load()
    const connection = this.connections.find((item) => item.id === id)
    if (!connection) throw new Error('MCP connection not found.')
    const available = safeStorage.isEncryptionAvailable()
    const clean = this.normalizeInput({
      name: patch.name ?? connection.name,
      transport: patch.transport ?? connection.transport,
      command: patch.command ?? connection.command,
      args: patch.args ?? connection.args,
      url: patch.url ?? connection.url,
      env: patch.env,
      headers: patch.headers
    })
    connection.name = clean.name
    connection.transport = clean.transport
    connection.command = clean.command
    connection.args = clean.args
    connection.url = clean.url
    if (patch.env !== undefined) {
      connection.env = this.mergeSecrets(clean.env, connection.env, connection.secretsEncrypted, available)
      connection.secretsEncrypted = available
    }
    if (patch.headers !== undefined) {
      connection.headers = this.mergeSecrets(clean.headers, connection.headers, connection.secretsEncrypted, available)
      connection.secretsEncrypted = available
    }
    if (patch.enabled !== undefined) connection.enabled = patch.enabled
    await this.save()
    if (connection.enabled) void this.connect(connection)
    else void this.disconnect(connection.id)
    return this.view(connection)
  }

  async remove(id: string): Promise<void> {
    await this.load()
    await this.disconnect(id)
    this.status.delete(id)
    this.connections = this.connections.filter((connection) => connection.id !== id)
    await this.save()
    this.notifyChange()
  }

  /** Tool definitions for agents, namespaced mcp_<slug>_<tool>. */
  agentToolDefinitions(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
    const definitions: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = []
    for (const connection of this.connections) {
      const live = this.live.get(connection.id)
      if (!connection.enabled || !live) continue
      for (const tool of live.tools) {
        definitions.push({
          name: `${MCP_TOOL_PREFIX}${connection.slug}_${tool.name}`,
          description: `[${connection.name}] ${tool.description ?? tool.name}`.slice(0, 1_000),
          inputSchema: tool.inputSchema ?? { type: 'object', additionalProperties: true }
        })
      }
    }
    return definitions
  }

  /** Resolve and call a namespaced tool. */
  async callAgentTool(namespacedName: string, args: unknown): Promise<unknown> {
    await this.load()
    const name = namespacedName.slice(MCP_TOOL_PREFIX.length)
    for (const connection of this.connections) {
      if (!connection.enabled || !name.startsWith(`${connection.slug}_`)) continue
      const live = this.live.get(connection.id)
      if (!live) throw new Error(`The "${connection.name}" connection is not ready.`)
      const toolName = name.slice(connection.slug.length + 1)
      if (!live.tools.some((tool) => tool.name === toolName)) continue
      const result = await live.client.callTool(toolName, args)
      const text = result.content
        .map((item) => (typeof item.text === 'string' ? item.text : ''))
        .filter(Boolean)
        .join('\n')
      if (result.isError) throw new Error(text || 'The MCP tool reported an error.')
      return text || JSON.stringify(result.content)
    }
    throw new Error(`Unknown MCP tool: ${namespacedName}. Use ralf_mcp_list to see available tools.`)
  }

  /** Compact listing for the generic ralf_mcp_list agent tool. */
  agentListing(): Array<{ tool: string; description: string }> {
    return this.agentToolDefinitions().map((definition) => ({
      tool: definition.name,
      description: definition.description
    }))
  }

  async importScan(): Promise<McpImportCandidate[]> {
    await this.load()
    const home = homedir()
    const candidates: McpImportCandidate[] = []
    const seen = new Set<string>()
    const push = (source: string, name: string, input: Omit<McpConnectionInput, 'name'>): void => {
      const key = input.command ? `stdio:${input.command} ${(input.args ?? []).join(' ')}` : `http:${input.url}`
      if (seen.has(key)) return
      seen.add(key)
      const alreadyConfigured = this.connections.some((connection) =>
        connection.transport === 'stdio'
          ? `${connection.command} ${(connection.args ?? []).join(' ')}` === `${input.command} ${(input.args ?? []).join(' ')}`
          : connection.url === input.url
      )
      candidates.push({ source, input: { name, ...input }, alreadyConfigured })
    }

    const readJson = (path: string): Record<string, unknown> | null => {
      try {
        return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> : null
      } catch {
        return null
      }
    }
    const pushJsonServers = (source: string, servers: unknown): void => {
      if (!servers || typeof servers !== 'object') return
      for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
        if (!raw || typeof raw !== 'object') continue
        const config = raw as { type?: string; command?: string; args?: unknown; env?: unknown; url?: string; headers?: unknown }
        if (config.url && (config.type === 'http' || config.type === 'sse' || !config.command)) {
          push(source, name, {
            transport: 'http',
            url: config.url,
            headers: config.headers && typeof config.headers === 'object' ? config.headers as Record<string, string> : undefined
          })
        } else if (config.command) {
          push(source, name, {
            transport: 'stdio',
            command: config.command,
            args: Array.isArray(config.args) ? config.args.map(String) : [],
            env: config.env && typeof config.env === 'object' ? config.env as Record<string, string> : undefined
          })
        }
      }
    }

    const claudeConfig = readJson(join(home, '.claude.json'))
    if (claudeConfig) {
      pushJsonServers('Claude Code (user)', claudeConfig.mcpServers)
      const projects = claudeConfig.projects
      if (projects && typeof projects === 'object') {
        for (const [path, project] of Object.entries(projects as Record<string, { mcpServers?: unknown }>)) {
          pushJsonServers(`Claude Code (${path})`, project?.mcpServers)
        }
      }
    }
    const desktopConfig = readJson(join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'))
    if (desktopConfig) pushJsonServers('Claude Desktop', desktopConfig.mcpServers)

    try {
      const codexPath = join(home, '.codex', 'config.toml')
      if (existsSync(codexPath)) {
        for (const server of codexMcpServers(readFileSync(codexPath, 'utf8'))) {
          const url = typeof server.values.url === 'string' ? server.values.url : ''
          if (url) {
            push('Codex', server.name, { transport: 'http', url })
          } else if (typeof server.values.command === 'string') {
            push('Codex', server.name, {
              transport: 'stdio',
              command: server.values.command,
              args: Array.isArray(server.values.args) ? server.values.args : []
            })
          }
        }
      }
    } catch {
      /* An unreadable codex config only skips its candidates. */
    }
    return candidates
  }

  async handle(request: BackendRequest): Promise<unknown> {
    switch (request.type) {
      case 'mcp.list': return this.list()
      case 'mcp.add': return this.add(request.input)
      case 'mcp.update': return this.update(request.connectionId, request.patch)
      case 'mcp.remove': return this.remove(request.connectionId)
      case 'mcp.import.scan': return this.importScan()
      default: throw new Error(`Unsupported MCP request: ${request.type}`)
    }
  }
}
