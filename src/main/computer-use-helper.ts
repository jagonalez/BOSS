import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import readline from 'node:readline'

const PROTOCOL_VERSION = '2025-03-26'

const KEY_CODES: Record<string, number> = {
  up: 126,
  down: 125,
  left: 123,
  right: 124,
  pageup: 116,
  pagedown: 121,
  home: 115,
  end: 119,
  enter: 36,
  return: 36,
  tab: 48,
  space: 49,
  esc: 53,
  escape: 53,
  delete: 51,
  backspace: 51,
  forwarddelete: 117,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111
}

const TOOLS = [
  {
    name: 'computer_use.snapshot',
    description:
      'Get the accessibility tree of the frontmost app and its windows. Returns UI elements with role, name, and screen bounds. Use this BEFORE clicking so you can target an element by its coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'Optional: app name to target instead of the frontmost app' }
      }
    }
  },
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
    name: 'computer_use.key',
    description: 'Send a keyboard shortcut or key press. Example combos: "cmd+shift+p", "cmd+c", "ctrl+up", "enter".',
    inputSchema: {
      type: 'object',
      properties: {
        combo: { type: 'string', description: 'Shortcut combo, e.g. "cmd+shift+p". Modifiers: cmd, ctrl, alt/opt, shift. Key may be a letter, number, or special key (up/down/left/right/enter/tab/space/esc/pageup/pagedown/home/end/f1-f12).' }
      },
      required: ['combo']
    }
  },
  {
    name: 'computer_use.scroll',
    description: 'Scroll the focused window by sending page-up/page-down or arrow keys.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], default: 'down' },
        amount: { type: 'number', default: 1, description: 'Number of page/arrow key presses' },
        keys: { type: 'string', enum: ['page', 'arrow'], default: 'page' }
      }
    }
  },
  {
    name: 'computer_use.screenshot',
    description: 'Capture a full-screen screenshot. Requires macOS Screen Recording permission. Use only when a vision-capable model is active.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'computer_use.window_activate',
    description: 'Bring an application to the front (frontmost). Use this before interacting with a specific app. Example: "Safari", "Finder".',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'Application name, e.g. "Safari"' }
      },
      required: ['app']
    }
  },
  {
    name: 'computer_use.window_move',
    description: 'Move the frontmost window of an app to a screen position. Coordinate origin is top-left.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'New top-left x' },
        y: { type: 'number', description: 'New top-left y' },
        app: { type: 'string', description: 'Optional app name; defaults to frontmost' }
      },
      required: ['x', 'y']
    }
  },
  {
    name: 'computer_use.window_resize',
    description: 'Resize the frontmost window of an app.',
    inputSchema: {
      type: 'object',
      properties: {
        width: { type: 'number', description: 'New width' },
        height: { type: 'number', description: 'New height' },
        app: { type: 'string', description: 'Optional app name; defaults to frontmost' }
      },
      required: ['width', 'height']
    }
  },
  {
    name: 'computer_use.window_close',
    description: 'Close the frontmost window of an app. Use with care.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'Optional app name; defaults to frontmost' }
      }
    }
  },
  {
    name: 'computer_use.drag',
    description: 'Click and drag from one screen coordinate to another (e.g. moving an item, selecting text, dragging a window).',
    inputSchema: {
      type: 'object',
      properties: {
        fromX: { type: 'number' },
        fromY: { type: 'number' },
        toX: { type: 'number' },
        toY: { type: 'number' }
      },
      required: ['fromX', 'fromY', 'toX', 'toY']
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
    execFile('osascript', ['-e', script], { timeout: 20000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message))
      else resolve(stdout.trim())
    })
  })
}

function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function mapModifier(m: string): string | null {
  switch (m) {
    case 'cmd':
    case 'command':
      return 'command down'
    case 'ctrl':
    case 'control':
      return 'control down'
    case 'alt':
    case 'opt':
    case 'option':
      return 'option down'
    case 'shift':
      return 'shift down'
    default:
      return null
  }
}

/** Build a System Events process reference: named app or the frontmost process. */
function procRef(app?: unknown): string {
  return typeof app === 'string' && app ? `process "${esc(app)}"` : 'first application process whose frontmost is true'
}

async function callTool(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  switch (name) {
    case 'computer_use.snapshot': {
      const app = typeof args.app === 'string' && args.app ? `process "${esc(args.app)}"` : 'first application process whose frontmost is true'
      const script = `
tell application "System Events"
  set LF to linefeed
  set out to ""
  try
    set frontProc to ${app}
    set out to out & "APP: " & (name of frontProc) & LF
    repeat with w in windows of frontProc
      set wName to ""
      try
        set wName to (name of w as text)
      end try
      set wPos to position of w
      set wSize to size of w
      set out to out & "WINDOW: " & wName & " @ " & (item 1 of wPos) & "," & (item 2 of wPos) & " " & (item 1 of wSize) & "x" & (item 2 of wSize) & LF
      set count to 0
      try
        repeat with el in entire contents of w
          if count >= 300 then exit repeat
          set count to count + 1
          set r to role of el
          set n to ""
          try
            set n to (name of el as text)
          end try
          set p to position of el
          set s to size of el
          set out to out & "  " & r & " | " & n & " | " & (item 1 of p) & "," & (item 2 of p) & " " & (item 1 of s) & "x" & (item 2 of s) & LF
        end repeat
      end try
    end repeat
  end try
  return out
end tell`
      const text = await osa(script)
      return {
        content: [
          {
            type: 'text',
            text:
              text || 'No accessibility tree available. Grant Ralf Accessibility permission in System Settings → Privacy & Security.'
          }
        ]
      }
    }
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
      await osa(`tell application "System Events" to keystroke "${esc(text)}"`)
      return { content: [{ type: 'text', text: `typed ${text.length} characters` }] }
    }
    case 'computer_use.key': {
      const combo = String(args.combo ?? '')
      const parts = combo.split('+').map((p) => p.trim().toLowerCase())
      const modifiers = parts.filter((p) => mapModifier(p)).map((p) => mapModifier(p) as string)
      const key = parts[parts.length - 1]
      if (!key) throw new Error('empty combo')
      const mods = modifiers.length ? ` using {${modifiers.join(', ')}}` : ''
      if (KEY_CODES[key] !== undefined) {
        await osa(`tell application "System Events" to key code ${KEY_CODES[key]}${mods}`)
      } else {
        if (key.length > 1) throw new Error(`unknown key: ${key}`)
        await osa(`tell application "System Events" to keystroke "${esc(key)}"${mods}`)
      }
      return { content: [{ type: 'text', text: `sent key combo ${combo}` }] }
    }
    case 'computer_use.scroll': {
      const direction = String(args.direction ?? 'down')
      const amount = Number(args.amount ?? 1)
      const keys = String(args.keys ?? 'page')
      const map: Record<string, number> =
        keys === 'arrow'
          ? { up: 126, down: 125, left: 123, right: 124 }
          : { up: 116, down: 121, left: 123, right: 124 }
      const code = map[direction]
      if (code === undefined) throw new Error(`invalid scroll direction: ${direction}`)
      for (let i = 0; i < amount; i++) {
        await osa(`tell application "System Events" to key code ${code}`)
      }
      return { content: [{ type: 'text', text: `scrolled ${direction} ${amount}` }] }
    }
    case 'computer_use.screenshot': {
      const out = join(tmpdir(), `ralf-shot-${Date.now()}.png`)
      await new Promise<void>((resolve, reject) => {
        execFile('screencapture', ['-x', out], (err) => (err ? reject(err) : resolve()))
      })
      const data = await readFile(out)
      return { content: [{ type: 'text', text: data.toString('base64') }] }
    }
    case 'computer_use.window_activate': {
      const app = String(args.app ?? '')
      if (!app) throw new Error('app is required')
      await osa(`tell application "${esc(app)}" to activate`)
      return { content: [{ type: 'text', text: `activated ${app}` }] }
    }
    case 'computer_use.window_move': {
      const p = procRef(args.app)
      const x = Number(args.x)
      const y = Number(args.y)
      await osa(`tell application "System Events" to set position of front window of ${p} to {${x}, ${y}}`)
      return { content: [{ type: 'text', text: `moved window to ${x},${y}` }] }
    }
    case 'computer_use.window_resize': {
      const p = procRef(args.app)
      const w = Number(args.width)
      const h = Number(args.height)
      await osa(`tell application "System Events" to set size of front window of ${p} to {${w}, ${h}}`)
      return { content: [{ type: 'text', text: `resized window to ${w}x${h}` }] }
    }
    case 'computer_use.window_close': {
      const p = procRef(args.app)
      await osa(`tell application "System Events" to close front window of ${p}`)
      return { content: [{ type: 'text', text: 'closed front window' }] }
    }
    case 'computer_use.drag': {
      const fromX = Number(args.fromX)
      const fromY = Number(args.fromY)
      const toX = Number(args.toX)
      const toY = Number(args.toY)
      await osa(
        `tell application "System Events"\n` +
          `  set t to 0.2\n` +
          `  click at {${fromX}, ${fromY}}\n` +
          `  delay t\n` +
          `  drag from {${fromX}, ${fromY}} to {${toX}, ${toY}}\n` +
          `end tell`
      )
      return { content: [{ type: 'text', text: `dragged from ${fromX},${fromY} to ${toX},${toY}` }] }
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
