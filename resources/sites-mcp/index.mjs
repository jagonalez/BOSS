// R.A.L.F. sites MCP server (stdio).
// Exposes a single tool `publish_site(folder, name?)` that forwards to the
// Ralf main-process control endpoint (loopback + random secret).
// Run via `ELECTRON_RUN_AS_NODE=1 electron <this-file>`.

const CONTROL_URL = process.env.RALF_SITES_CONTROL_URL
const SECRET = process.env.RALF_SITES_SECRET

const TOOL = {
  name: 'publish_site',
  description:
    'Publish a folder of static files (a site/artifact) so it is served locally in Ralf and can be previewed in a browser. Use this after generating a site (HTML/CSS/JS) into a folder to make it viewable and optionally deployed to Cloudflare. Provide the absolute folder path or a path relative to the project.',
  inputSchema: {
    type: 'object',
    properties: {
      folder: {
        type: 'string',
        description: 'Folder containing the built site. Absolute path or relative to the project root.'
      },
      name: { type: 'string', description: 'Optional human-readable name for the site.' }
    },
    required: ['folder']
  }
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

async function handle(msg) {
  if (!msg || typeof msg.method !== 'string') return

  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'ralf-sites', version: '0.1.0' }
      }
    })
    return
  }
  if (msg.method === 'notifications/initialized') return
  if (msg.method === 'ping') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} })
    return
  }
  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [TOOL] } })
    return
  }
  if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params || {}
    if (name === 'publish_site') {
      try {
        const res = await fetch(`${CONTROL_URL}/publish`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
          body: JSON.stringify({ folder: args?.folder, name: args?.name })
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`)
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: `Published site at ${data.url}` }] }
        })
      } catch (err) {
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: `publish_site failed: ${err.message}` }], isError: true }
        })
      }
    }
    return
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let idx
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim()
    buffer = buffer.slice(idx + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    void handle(msg)
  }
})
