import { execFile, spawn } from 'node:child_process'
import type { BackendAuthStatus, BackendId, BackendSubscriptionUsage } from '../shared/backend'
import { claudeUsageWindows, codexUsageWindows } from './subscription-usage'

export interface AuthLaunch {
  command: string
  args: string[]
  initialInput?: string
}

function run(command: string, args: string[], timeout = 8_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    execFile(command, args, { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolveRun({
        code: error ? Number((error as NodeJS.ErrnoException & { code?: number }).code) || 1 : 0,
        stdout: String(stdout),
        stderr: String(stderr)
      })
    })
  })
}

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, '')
}

/** Read Codex's structured account limits without starting a thread or sending
 * a model request. The app-server protocol is JSON-RPC over stdio. */
function codexRateLimits(): Promise<unknown> {
  return new Promise((resolve) => {
    const child = spawn('codex', ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'ignore'] })
    let settled = false
    let buffer = ''
    const finish = (value: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      child.kill()
      resolve(value)
    }
    const send = (message: unknown): void => { child.stdin.write(`${JSON.stringify(message)}\n`) }
    const timeout = setTimeout(() => finish(undefined), 12_000)
    child.once('error', () => finish(undefined))
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        try {
          const message = JSON.parse(line) as { id?: number; result?: unknown }
          if (message.id === 1) {
            send({ method: 'initialized' })
            send({ id: 2, method: 'account/rateLimits/read', params: {} })
          } else if (message.id === 2) {
            finish(message.result)
          }
        } catch {
          // Stdio can include a partial or diagnostic line. Only JSON-RPC
          // replies with the request id are relevant here.
        }
      }
    })
    send({
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'BOSS', title: 'BOSS', version: '0.1.0' }, capabilities: null }
    })
  })
}

export class BackendAuth {
  constructor(private readonly openCodeCommand: () => string) {}

  launch(backendId: BackendId): AuthLaunch {
    switch (backendId) {
      case 'codex': return { command: 'codex', args: ['login'] }
      case 'claude': return { command: 'claude', args: ['auth', 'login'] }
      case 'opencode': return { command: this.openCodeCommand(), args: ['auth', 'login'] }
      case 'pi': return { command: 'pi', args: [], initialInput: '/login\r' }
      // Lab needs no CLI sign-in: it authenticates through LAB_API_KEY on the
      // endpoint itself, so there is nothing to launch in a terminal.
      case 'lab': throw new Error('Lab connects to an OpenAI-compatible endpoint; no CLI sign-in is needed.')
    }
  }

  private async codexStatus(): Promise<BackendAuthStatus> {
    const result = await run('codex', ['login', 'status'])
    const output = `${result.stdout}\n${result.stderr}`
    if (/logged in/i.test(output)) {
      const detail = output.match(/logged in using\s+([^\r\n]+)/i)?.[1]?.trim() || 'Codex account'
      return { backendId: 'codex', state: 'connected', detail }
    }
    return { backendId: 'codex', state: result.code === 0 ? 'unknown' : 'not-connected', detail: 'Run Codex login to connect ChatGPT or an API key.' }
  }

  private async claudeStatus(): Promise<BackendAuthStatus> {
    const result = await run('claude', ['auth', 'status', '--json'])
    try {
      const parsed = JSON.parse(result.stdout) as { loggedIn?: boolean; authMethod?: string; email?: string; subscriptionType?: string }
      return parsed.loggedIn
        ? { backendId: 'claude', state: 'connected', detail: parsed.subscriptionType ? `${parsed.authMethod || 'Claude'} · ${parsed.subscriptionType}` : parsed.authMethod || 'Claude account', accounts: parsed.email ? [parsed.email] : undefined }
        : { backendId: 'claude', state: 'not-connected', detail: 'Connect a Claude subscription or Anthropic Console account.' }
    } catch {
      return { backendId: 'claude', state: 'unknown', detail: 'Claude authentication status is unavailable.' }
    }
  }

  private async openCodeStatus(): Promise<BackendAuthStatus> {
    const result = await run(this.openCodeCommand(), ['auth', 'list'])
    const output = stripAnsi(`${result.stdout}\n${result.stderr}`)
    const count = Number(output.match(/(\d+) credentials?/i)?.[1] ?? 0)
    const accounts = output.split('\n')
      .map((line) => line.match(/^\s*[●•]\s+(.+?)\s+(?:api|oauth)\s*$/i)?.[1]?.trim())
      .filter((value): value is string => Boolean(value))
    if (count > 0 || accounts.length > 0) {
      return {
        backendId: 'opencode',
        state: 'connected',
        detail: `${count || accounts.length} provider credential${(count || accounts.length) === 1 ? '' : 's'}`,
        accounts
      }
    }
    return {
      backendId: 'opencode',
      state: result.code === 0 ? 'not-connected' : 'unknown',
      detail: result.code === 0 ? 'Connect at least one model provider.' : 'OpenCode credential status is unavailable.'
    }
  }

  private async piStatus(): Promise<BackendAuthStatus> {
    const providers = ['openai-codex', 'anthropic', 'github-copilot']
    const checked = await Promise.all(providers.map(async (provider) => {
      const result = await run('pi', ['auth', 'check', '--provider', provider, '--json', '--no-refresh'])
      try {
        const parsed = JSON.parse(result.stdout) as { status?: string }
        return parsed.status === 'ready' ? provider : undefined
      } catch {
        return undefined
      }
    }))
    const environmentProviders = [
      ['ANTHROPIC_API_KEY', 'Anthropic API'], ['OPENAI_API_KEY', 'OpenAI API'], ['GEMINI_API_KEY', 'Google Gemini'],
      ['OPENROUTER_API_KEY', 'OpenRouter'], ['DEEPSEEK_API_KEY', 'DeepSeek'], ['OPENCODE_API_KEY', 'OpenCode']
    ].filter(([key]) => Boolean(process.env[key])).map(([, label]) => label)
    const accounts = [...checked.filter((value): value is string => Boolean(value)), ...environmentProviders]
    return accounts.length
      ? { backendId: 'pi', state: 'connected', detail: `${accounts.length} ready provider${accounts.length === 1 ? '' : 's'}`, accounts }
      : { backendId: 'pi', state: 'not-connected', detail: 'Use /login for ChatGPT, Claude, or Copilot, or configure a provider API key.' }
  }

  async statuses(): Promise<BackendAuthStatus[]> {
    return Promise.all([this.openCodeStatus(), this.piStatus(), this.codexStatus(), this.claudeStatus()])
  }

  async subscriptionUsage(): Promise<BackendSubscriptionUsage[]> {
    const updatedAt = Date.now()
    const [codex, claude] = await Promise.all([
      (async (): Promise<BackendSubscriptionUsage> => {
        const normalized = codexUsageWindows(await codexRateLimits())
        return normalized.windows.length
          ? { backendId: 'codex', ...normalized, updatedAt }
          : { backendId: 'codex', windows: [], unavailableReason: 'Codex did not report subscription limits for this account. API-key billing is not exposed here.', updatedAt }
      })(),
      (async (): Promise<BackendSubscriptionUsage> => {
        const status = await this.claudeStatus()
        if (status.state !== 'connected') {
          return { backendId: 'claude', windows: [], unavailableReason: 'Sign in with a Claude subscription to view its limits.', updatedAt }
        }
        const result = await run('claude', ['--print', '--output-format', 'json', '--no-session-persistence', '/usage'], 15_000)
        let output: unknown
        try { output = (JSON.parse(result.stdout) as { result?: unknown }).result } catch { /* unavailable below */ }
        const windows = claudeUsageWindows(output)
        return windows.length
          ? { backendId: 'claude', plan: status.detail, windows, updatedAt }
          : { backendId: 'claude', windows: [], unavailableReason: 'Claude did not report subscription limits for this credential. API-key billing is not exposed here.', updatedAt }
      })()
    ])
    return [
      { backendId: 'opencode', windows: [], unavailableReason: 'OpenCode can use many providers, so it cannot report one subscription balance.', updatedAt },
      { backendId: 'pi', windows: [], unavailableReason: 'Pi can use many providers, so it cannot report one subscription balance.', updatedAt },
      codex,
      claude,
      { backendId: 'lab', windows: [], unavailableReason: 'Lab API usage is not connected to a provider billing account.', updatedAt }
    ]
  }
}
