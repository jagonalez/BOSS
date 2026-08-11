import { execFile } from 'node:child_process'
import type { BackendAuthStatus, BackendId } from '../shared/backend'

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

export class BackendAuth {
  constructor(private readonly openCodeCommand: () => string) {}

  launch(backendId: BackendId): AuthLaunch {
    switch (backendId) {
      case 'codex': return { command: 'codex', args: ['login'] }
      case 'claude': return { command: 'claude', args: ['auth', 'login'] }
      case 'opencode': return { command: this.openCodeCommand(), args: ['auth', 'login'] }
      case 'pi': return { command: 'pi', args: [], initialInput: '/login\r' }
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
      const parsed = JSON.parse(result.stdout) as { loggedIn?: boolean; authMethod?: string; email?: string }
      return parsed.loggedIn
        ? { backendId: 'claude', state: 'connected', detail: parsed.authMethod || 'Claude account', accounts: parsed.email ? [parsed.email] : undefined }
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
}
