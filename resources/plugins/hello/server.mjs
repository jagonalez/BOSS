#!/usr/bin/env node
/**
 * The smallest working BOSS plugin server, and the file to copy when writing
 * your own.
 *
 * The protocol is newline-delimited JSON-RPC on stdin and stdout, and a plugin
 * only has to answer three methods: initialize, tools/list, tools/call.
 *
 * It stores nothing on purpose. Storage is where plugins get interesting and
 * where they get subtle, so this example shows only the wiring — how a tool is
 * declared, how it is called, and what comes back — and points at the two
 * things you need when you do want to persist:
 *
 *   BOSS_PLUGIN_DATA_DIR   a private directory, created for you
 *   args.project           which project the call is for, set by BOSS
 *
 * Read both and you get per-project storage in one line:
 *   join(process.env.BOSS_PLUGIN_DATA_DIR, args.project.projectId, 'state.json')
 * Ignore the project and your plugin is global, which is a fine choice too.
 */

// Counts calls for the life of this process, so the view can show it is really
// talking to a running server rather than to a cached page.
let callsHandled = 0
const startedAt = new Date().toISOString()

const TOOLS = [
  {
    name: 'info',
    description: 'Report who this plugin is, where BOSS put it, and which project the call came from.',
    // "project" is accepted but not required: BOSS adds it to every call, so a
    // schema with additionalProperties: false has to allow it.
    inputSchema: { type: 'object', properties: {}, additionalProperties: true }
  },
  {
    name: 'greet',
    description: 'Say hello to someone by name.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Who to greet.' } },
      required: ['name'],
      additionalProperties: true
    }
  }
]

function callTool(name, args) {
  callsHandled += 1
  // BOSS sets this on every call, from the agent and from the view alike, so
  // the two can never disagree about which project they are in.
  const project = args?.project ?? { projectId: 'global', projectPath: '' }

  if (name === 'info') {
    return {
      plugin: 'hello',
      directory: process.env.BOSS_PLUGIN_DIR ?? '(not set)',
      dataDirectory: process.env.BOSS_PLUGIN_DATA_DIR ?? '(not set)',
      projectId: project.projectId,
      projectPath: project.projectPath || '(no project open)',
      node: process.version,
      serverStartedAt: startedAt,
      callsHandled
    }
  }

  if (name === 'greet') {
    const who = typeof args?.name === 'string' ? args.name.trim() : ''
    if (!who) throw new Error('Pass a name to greet.')
    return { message: `Hello, ${who}.`, projectId: project.projectId, callsHandled }
  }

  throw new Error(`Unknown tool: ${name}`)
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function handle(request) {
  if (request.method === 'initialize') {
    return {
      protocolVersion: '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'boss-plugin-hello', version: '1.0.0' },
      instructions:
        'A demonstration plugin. Call plugin_hello_info to show it is running and which project it sees, or plugin_hello_greet with a name. It stores nothing.'
    }
  }
  if (request.method === 'tools/list') return { tools: TOOLS }
  if (request.method === 'tools/call') {
    try {
      const result = callTool(request.params?.name, request.params?.arguments ?? {})
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    } catch (error) {
      return {
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
        isError: true
      }
    }
  }
  return undefined
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index = buffer.indexOf('\n')
  while (index >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line) {
      let request = null
      try {
        request = JSON.parse(line)
      } catch {
        /* A line that is not JSON is not answerable. */
      }
      if (request) {
        const result = handle(request)
        // A notification has no id and wants no reply.
        if (request.id !== undefined && result !== undefined) {
          send({ jsonrpc: '2.0', id: request.id, result })
        }
      }
    }
    index = buffer.indexOf('\n')
  }
})
