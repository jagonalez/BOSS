import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import net from 'node:net'
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { ServerInfo } from '@shared/ipc'
import type { ThreadBusConnection } from '@shared/thread-bus'
import { THREAD_TOOL_DESCRIPTIONS } from '@shared/thread-bus'
import { qaDescription } from '@shared/qa'

interface Health {
  healthy: boolean
  version: string
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo
      srv.close(() => resolve(addr.port))
    })
  })
}

export function resolveOpenCodeBin(): string {
  const exe = process.platform === 'win32' ? 'opencode.exe' : 'opencode'
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN
  if (!app.isPackaged) return exe
  const candidates = [
    join(process.resourcesPath ?? '', 'opencode', exe),
    join(app.getAppPath(), 'resources', 'opencode', exe)
  ]
  for (const c of candidates) {
    try {
      if (statSync(c).isFile()) return c
    } catch {
      /* skip */
    }
  }
  return exe
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

async function fetchHealth(base: string, auth: string): Promise<Health | null> {
  try {
    const res = await fetch(`${base}/global/health`, {
      headers: { Authorization: auth }
    })
    if (!res.ok) {
      if (process.env.BOSS_DEBUG) {
        process.stderr.write(`[opencode] health status ${res.status}\n`)
      }
      return null
    }
    const json = (await res.json()) as { healthy?: boolean; version?: string }
    return { healthy: Boolean(json.healthy), version: String(json.version ?? '') }
  } catch (err) {
    if (process.env.BOSS_DEBUG) {
      const cause = (err as Error).cause as { code?: string } | undefined
      process.stderr.write(`[opencode] health fetch error: ${(err as Error).message} code=${cause?.code}\n`)
    }
    return null
  }
}

export class OpenCodeServer {
  private proc: ChildProcess | null = null
  private port = 0
  private password = ''
  private healthy = false
  private version = ''
  private stopping = false
  private suppressRestart = false
  private restartTimer: NodeJS.Timeout | null = null
  private attempts = 0
  private cwd = app.getPath('home')
  private fallbackToPath = false
  private threadBus?: ThreadBusConnection
  private threadBusConfigDir = ''

  onStatusChange?: (info: ServerInfo) => void

  get info(): ServerInfo {
    return {
      port: this.port,
      url: this.baseUrl,
      version: this.version,
      healthy: this.healthy
    }
  }

  get projectPath(): string {
    return this.cwd
  }

  setInitialCwd(path: string): void {
    if (isDirectory(path)) this.cwd = path
  }

  configureThreadBus(connection: ThreadBusConnection): void {
    this.threadBus = connection
    if (process.env.OPENCODE_CONFIG_DIR) {
      if (process.env.BOSS_DEBUG) process.stderr.write('[opencode] OPENCODE_CONFIG_DIR is already set; BOSS thread tools were not injected.\n')
      return
    }
    this.threadBusConfigDir = join(app.getPath('userData'), 'opencode-boss')
    const toolsDir = join(this.threadBusConfigDir, 'tools')
    mkdirSync(toolsDir, { recursive: true })
    writeFileSync(join(toolsDir, 'boss_threads.ts'), this.threadToolSource())
    writeFileSync(join(toolsDir, 'boss.ts'), this.qaToolSource())
  }

  private threadToolSource(): string {
    return `import { tool } from "@opencode-ai/plugin"

async function call(name, args, context) {
  const url = process.env.BOSS_THREAD_BUS_URL
  const token = process.env.BOSS_THREAD_BUS_TOKEN
  if (!url || !token) throw new Error("BOSS thread collaboration is unavailable.")
  const response = await fetch(url + "/agent-call", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: JSON.stringify({ backendId: "opencode", nativeThreadId: context.sessionID, tool: name, arguments: args })
  })
  const payload = await response.json()
  if (!response.ok || !payload.ok) throw new Error(payload.error || "BOSS thread tool failed.")
  const result = payload.result
  if (result && result.__bossToolResult) {
    return {
      title: "BOSS QA",
      output: result.text,
      metadata: { bossQa: true },
      attachments: result.image ? [{
        type: "file",
        mime: result.image.mimeType,
        url: "data:" + result.image.mimeType + ";base64," + result.image.data,
        filename: "boss-qa.png"
      }] : []
    }
  }
  return JSON.stringify(result, null, 2)
}

export const list = tool({
  description: ${JSON.stringify(THREAD_TOOL_DESCRIPTIONS.list)},
  args: {},
  execute(args, context) { return call("boss_threads_list", args, context) }
})

export const read = tool({
  description: ${JSON.stringify(THREAD_TOOL_DESCRIPTIONS.read)},
  args: {
    threadId: tool.schema.string().describe("BOSS thread id returned by boss_threads_list"),
    limit: tool.schema.number().min(1).max(20).optional()
  },
  execute(args, context) { return call("boss_threads_read", args, context) }
})

export const send = tool({
  description: ${JSON.stringify(THREAD_TOOL_DESCRIPTIONS.send)},
  args: {
    threadId: tool.schema.string().describe("Target BOSS thread id"),
    message: tool.schema.string().describe("Concise context, question, or requested task"),
    expectsReply: tool.schema.boolean().optional(),
    maxTurns: tool.schema.number().min(1).max(8).optional()
  },
  execute(args, context) { return call("boss_threads_send", args, context) }
})

export const reply = tool({
  description: ${JSON.stringify(THREAD_TOOL_DESCRIPTIONS.reply)},
  args: {
    messageId: tool.schema.string().describe("Message id from the incoming BOSS thread message"),
    message: tool.schema.string().describe("Reply for the sending thread"),
    expectsReply: tool.schema.boolean().optional()
  },
  execute(args, context) { return call("boss_threads_reply", args, context) }
})

export const spawn_worktree = tool({
  description: ${JSON.stringify(THREAD_TOOL_DESCRIPTIONS.spawnWorktree)},
  args: {
    instruction: tool.schema.string().describe(${JSON.stringify(THREAD_TOOL_DESCRIPTIONS.spawnWorktreeInstruction)}),
    agent: tool.schema.enum(["opencode", "pi", "codex", "claude"])
      .describe(${JSON.stringify(THREAD_TOOL_DESCRIPTIONS.spawnWorktreeAgent)}).optional()
  },
  execute(args, context) { return call("boss_threads_spawn_worktree", args, context) }
})

export const use_worktree = tool({
  description: ${JSON.stringify(THREAD_TOOL_DESCRIPTIONS.useWorktree)},
  args: {},
  execute(args, context) { return call("boss_threads_use_worktree", args, context) }
})

export const leave_worktree = tool({
  description: ${JSON.stringify(THREAD_TOOL_DESCRIPTIONS.leaveWorktree)},
  args: {},
  execute(args, context) { return call("boss_threads_leave_worktree", args, context) }
})

export const git_create_change_request = tool({
  description: ${JSON.stringify(THREAD_TOOL_DESCRIPTIONS.createChangeRequest)},
  args: {
    title: tool.schema.string().optional().describe(${JSON.stringify(THREAD_TOOL_DESCRIPTIONS.createChangeRequestTitle)}),
    body: tool.schema.string().optional().describe(${JSON.stringify(THREAD_TOOL_DESCRIPTIONS.createChangeRequestBody)}),
    baseBranch: tool.schema.string().optional().describe(${JSON.stringify(THREAD_TOOL_DESCRIPTIONS.createChangeRequestBase)}),
    draft: tool.schema.boolean().optional().describe(${JSON.stringify(THREAD_TOOL_DESCRIPTIONS.createChangeRequestDraft)})
  },
  execute(args, context) { return call("boss_git_create_change_request", args, context) }
})

export const mcp_list = tool({
  description: "List external MCP tools available through BOSS connections. Pass tool to get one tool's full input schema before calling it.",
  args: {
    tool: tool.schema.string().optional().describe("Tool name from the catalog; returns its full input schema")
  },
  execute(args, context) { return call("boss_mcp_list", args, context) }
})

export const mcp_call = tool({
  description: "Call an external MCP tool listed by boss_mcp_list.",
  args: {
    tool: tool.schema.string().describe("Tool name from boss_mcp_list"),
    arguments: tool.schema.record(tool.schema.string(), tool.schema.unknown()).optional()
  },
  execute(args, context) { return call("boss_mcp_call", args, context) }
})
`
  }

  private qaToolSource(): string {
    return `import { tool } from "@opencode-ai/plugin"

async function call(name, args, context) {
  const url = process.env.BOSS_THREAD_BUS_URL
  const token = process.env.BOSS_THREAD_BUS_TOKEN
  if (!url || !token) throw new Error("BOSS QA tools are unavailable.")
  const response = await fetch(url + "/agent-call", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: JSON.stringify({ backendId: "opencode", nativeThreadId: context.sessionID, tool: name, arguments: args })
  })
  const payload = await response.json()
  if (!response.ok || !payload.ok) throw new Error(payload.error || "BOSS QA tool failed.")
  const result = payload.result
  return {
    title: "BOSS QA",
    output: result.text,
    metadata: { bossQa: true },
    attachments: result.image ? [{
      type: "file",
      mime: result.image.mimeType,
      url: "data:" + result.image.mimeType + ";base64," + result.image.data,
      filename: "boss-qa.png"
    }] : []
  }
}

export const browser_tabs = tool({
  description: ${JSON.stringify(qaDescription("boss_browser_tabs"))},
  args: {},
  execute(args, context) { return call("boss_browser_tabs", args, context) }
})
export const browser_navigate = tool({
  description: ${JSON.stringify(qaDescription("boss_browser_navigate"))},
  args: { tabId: tool.schema.string(), url: tool.schema.string() },
  execute(args, context) { return call("boss_browser_navigate", args, context) }
})
export const browser_snapshot = tool({
  description: ${JSON.stringify(qaDescription("boss_browser_snapshot"))},
  args: { tabId: tool.schema.string() },
  execute(args, context) { return call("boss_browser_snapshot", args, context) }
})
export const browser_screenshot = tool({
  description: ${JSON.stringify(qaDescription("boss_browser_screenshot"))},
  args: { tabId: tool.schema.string() },
  execute(args, context) { return call("boss_browser_screenshot", args, context) }
})
export const browser_click = tool({
  description: ${JSON.stringify(qaDescription("boss_browser_click"))},
  args: { tabId: tool.schema.string(), ref: tool.schema.string() },
  execute(args, context) { return call("boss_browser_click", args, context) }
})
export const browser_type = tool({
  description: ${JSON.stringify(qaDescription("boss_browser_type"))},
  args: { tabId: tool.schema.string(), ref: tool.schema.string(), text: tool.schema.string(), submit: tool.schema.boolean().optional() },
  execute(args, context) { return call("boss_browser_type", args, context) }
})
export const computer = tool({
  description: ${JSON.stringify(qaDescription("boss_computer"))},
  args: {
    operation: tool.schema.enum(["list_apps", "list_windows", "get_window_state", "get_desktop_state", "screenshot", "zoom", "click", "type_text", "press_key", "hotkey", "scroll", "wait"]),
    arguments: tool.schema.record(tool.schema.string(), tool.schema.unknown()).optional()
  },
  execute(args, context) { return call("boss_computer", args, context) }
})
`
  }

  /**
   * Switching project no longer restarts the server. Requests carry the target
   * directory in `x-opencode-directory` (see ApiClient), and opencode-backend
   * tracks a directory per session, so one server serves every project. The old
   * SIGTERM-and-respawn cost up to 1.5s waiting for exit plus ~540ms to boot,
   * and flagged the server unhealthy throughout — which surfaced as a red
   * "Core project service unavailable" pill on every switch.
   */
  async setProject(path: string): Promise<void> {
    if (!path || path === this.cwd) return
    if (!isDirectory(path)) {
      throw new Error(`project directory does not exist: ${path}`)
    }
    this.cwd = path
    // A server that has never started still needs its spawn cwd set.
    if (!this.proc && !process.env.BOSS_SERVER_URL) await this.start()
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`
  }

  get authHeader(): string {
    return `Basic ${Buffer.from(`opencode:${this.password}`).toString('base64')}`
  }

  async start(): Promise<void> {
    this.suppressRestart = false
    const extUrl = process.env.BOSS_SERVER_URL
    const extPass = process.env.BOSS_SERVER_PASSWORD
    if (extUrl && extPass) {
      const parsed = new URL(extUrl)
      this.port = Number(parsed.port || 80)
      this.password = extPass
      if (process.env.BOSS_DEBUG) process.stderr.write(`[opencode] connecting to external server ${extUrl}\n`)
      await this.waitForHealth()
      return
    }
    this.port = await getFreePort()
    this.password = randomBytes(32).toString('hex')
    const bin = this.fallbackToPath ? (process.platform === 'win32' ? 'opencode.exe' : 'opencode') : resolveOpenCodeBin()
    const proc = spawn(bin, ['serve', '--port', String(this.port), '--hostname', '127.0.0.1'], {
      cwd: isDirectory(this.cwd) ? this.cwd : app.getPath('home'),
      env: {
        ...process.env,
        OPENCODE_SERVER_PASSWORD: this.password,
        OPENCODE_SERVER_USERNAME: 'opencode',
        ...(this.threadBus ? {
          BOSS_THREAD_BUS_URL: this.threadBus.url,
          BOSS_THREAD_BUS_TOKEN: this.threadBus.token
        } : {}),
        ...(this.threadBusConfigDir ? { OPENCODE_CONFIG_DIR: this.threadBusConfigDir } : {})
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    this.proc = proc
    if (process.env.BOSS_DEBUG) process.stderr.write(`[opencode] spawning ${bin} on port ${this.port} cwd=${this.cwd}\n`)
    proc.stdout?.on('data', (d) => {
      if (process.env.BOSS_DEBUG) process.stderr.write(`[opencode:out] ${d}`)
    })
    proc.stderr?.on('data', (d) => {
      if (process.env.BOSS_DEBUG) process.stderr.write(`[opencode] ${d}`)
    })
    proc.on('error', (err) => {
      this.proc = null
      this.healthy = false
      this.emitStatus()
      if (this.stopping || this.suppressRestart) return
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        this.fallbackToPath = true
      }
      if (process.env.BOSS_DEBUG) process.stderr.write(`[opencode] spawn error: ${err.message}\n`)
      this.scheduleRestart(1, null)
    })
    proc.on('exit', (code, signal) => {
      this.proc = null
      this.healthy = false
      this.emitStatus()
      if (!this.stopping && !this.suppressRestart) this.scheduleRestart(code, signal)
    })
    await this.waitForHealth()
  }

  private scheduleRestart(code: number | null, signal: NodeJS.Signals | null): void {
    this.attempts += 1
    const delay = Math.min(1000 * 2 ** this.attempts, 15000)
    if (process.env.BOSS_DEBUG) {
      process.stderr.write(`[opencode] exited (${code ?? signal}), restarting in ${delay}ms\n`)
    }
    this.restartTimer = setTimeout(() => {
      void this.start()
    }, delay)
  }

  private async waitForHealth(): Promise<void> {
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      const health = await fetchHealth(this.baseUrl, this.authHeader)
      if (health) {
        this.healthy = health.healthy
        this.version = health.version
        this.attempts = 0
        this.fallbackToPath = false
        this.emitStatus()
        return
      }
      await new Promise((r) => setTimeout(r, 200))
    }
    if (process.env.BOSS_DEBUG) process.stderr.write('[opencode] health check timed out\n')
    this.emitStatus()
  }

  private emitStatus(): void {
    this.onStatusChange?.(this.info)
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.restartTimer) clearTimeout(this.restartTimer)
    const proc = this.proc
    this.proc = null
    if (proc) {
      await new Promise<void>((resolve) => {
        proc.once('exit', () => resolve())
        proc.kill('SIGTERM')
        setTimeout(() => resolve(), 2000)
      })
    }
  }
}
