import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import readline from 'node:readline'

const PROTOCOL_VERSION = '2025-03-26'

const TOOLS = [
  {
    name: 'computer_use.click',
    description: 'Click at a screen coordinate. Requires macOS Accessibility permission.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Screen x coordinate' },
        y: { type: 'number', description: 'Screen y coordinate' },
        button: { type: 'string', enum: ['left', 'right'], default: 'left' },
        clicks: { type: 'number', default: 1 }
      },
      required: ['x', 'y']
    }
  },
  {
    name: 'computer_use.type',
    description: 'Type text into the focused app. Requires macOS Accessibility permission.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' }
      },
      required: ['text']
    }
  },
  {
    name: 'computer_use.screenshot',
    description: 'Capture a full-screen screenshot. Requires macOS Screen Recording permission.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  }
]

function respond(id: unknown, result: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

function respondError(id: unknown, code: number, message: string): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n')
}

function notify(method: string, params: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
}

function osa(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message))
      else resolve(stdout.trim())
    })
  })
}

async function callTool(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  switch (name) {
    case 'computer_use.click': {
      const x = Number(args.x)
      const y = Number(args.y)
      const button = args.button === 'right' ? 2 : 1
      const clicks = Number(args.clicks ?? 1)
      await osa(`tell application "System Events" to click at {${x}, ${y}} with click count ${clicks} at button ${button}`)
      return { content: [{ type: 'text', text: `clicked at ${x},${y}` }] }
    }
    case 'computer_use.type': {
      const text = String(args.text ?? '')
      const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      await osa(`tell application "System Events" to keystroke "${escaped}"`)
      return { content: [{ type: 'text', text: `typed ${text.length} characters` }] }
    }
    case 'computer_use.screenshot': {
      const out = join(tmpdir(), `ralf-shot-${Date.now()}.png`)
      await new Promise<void>((resolve, reject) => {
        execFile('screencapture', ['-x', out], (err) => (err ? reject(err) : resolve()))
      })
      const data = await readFile(out)
      return { content: [{ type: 'text', text: data.toString('base64') }] }
    }
    default:
      return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true }
  }
}

const rl = readline.createInterface({ input: process.stdin })

rl.on('line', async (line) => {
  if (!line.trim()) return
  let msg: { method?: string; id?: unknown; params?: Record<string, unknown> }
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.method === 'initialize') {
    respond(msg.id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'ralf-computer-use', version: '0.1.0' }
    })
    notify('notifications/initialized', {})
    return
  }
  if (msg.method === 'tools/list') {
    respond(msg.id, { tools: TOOLS })
    return
  }
  if (msg.method === 'tools/call') {
    const p = (msg.params ?? {}) as { name: string; arguments?: Record<string, unknown> }
    try {
      const result = await callTool(p.name, p.arguments ?? {})
      respond(msg.id, result)
    } catch (err) {
      respondError(msg.id, -32000, String((err as Error).message ?? err))
    }
    return
  }
  if (msg.method === 'ping') {
    respond(msg.id, {})
    return
  }
  if (msg.method && msg.id === undefined) {
    return
  }
  respondError(msg.id, -32601, `method not found: ${String(msg.method ?? '')}`)
})

rl.on('close', () => {
  process.exit(0)
})
