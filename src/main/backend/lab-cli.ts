import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import type { BackendModeId } from '@shared/backend'
import type { SessionInfo } from '@shared/opencode'
// The explicit extensions keep this module executable under Node's type-stripping test runner.
// @ts-expect-error Application builds use bundler resolution.
import { applyProfilePresets, configFromEnv, loadDotEnv } from './lab-config.ts'
// @ts-expect-error Application builds use bundler resolution.
import { LabEngine, type EngineGate, type EngineSink } from './lab-engine.ts'
import type { LabFunctionCall } from './lab-tool-call.ts'

const VERSION = '0.1.0'
const MODES: BackendModeId[] = ['ask', 'auto', 'accept-edits', 'plan']

export function isMode(value: string): value is BackendModeId {
  return (MODES as string[]).includes(value)
}

export interface CliArgs {
  storeFile: string
  configFile: string
  cwd: string
  mode: BackendModeId
  model?: string
  newSession: boolean
  listSessions: boolean
  listModels: boolean
  showHelp: boolean
  sessionId?: string
  /** A single prompt passed on the command line; without one the CLI is
   *  interactive. */
  prompt?: string
}

function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? process.cwd()
}

export function defaultStoreFile(): string {
  return join(homeDir(), '.lab', 'threads.json')
}

export function defaultConfigFile(): string {
  return join(homeDir(), '.lab', 'config.json')
}

/** Parse CLI flags. `tty` decides the default permission mode: a terminal
 *  asks, a pipe (scripts, CI) runs in auto so it never blocks on a prompt. */
export function parseArgs(argv: string[], opts: { tty?: boolean } = {}): CliArgs {
  const tty = opts.tty ?? process.stdin.isTTY === true
  let storeFile = defaultStoreFile()
  let configFile = defaultConfigFile()
  let cwd = process.cwd()
  let mode: BackendModeId = tty ? 'ask' : 'auto'
  let model: string | undefined
  let newSession = false
  let listSessions = false
  let listModels = false
  let showHelp = false
  let sessionId: string | undefined
  const positional: string[] = []

  const value = (index: number, flag: string): string => {
    const next = argv[index]
    if (!next) throw new Error(`Missing value for ${flag}`)
    return next
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--help':
      case '-h':
        showHelp = true
        break
      case '--version':
      case '-v':
        console.log(`lab ${VERSION}`)
        process.exit(0)
        break
      case '--new':
        newSession = true
        break
      case '--session':
        sessionId = value(++i, arg)
        break
      case '--sessions':
        listSessions = true
        break
      case '--models':
        listModels = true
        break
      case '--store':
        storeFile = value(++i, arg)
        break
      case '--config':
        configFile = value(++i, arg)
        break
      case '--cwd':
        cwd = value(++i, arg)
        break
      case '--mode': {
        const raw = value(++i, arg)
        if (!isMode(raw)) throw new Error(`Unknown mode ${raw} (expected ask, auto, accept-edits, or plan)`)
        mode = raw
        break
      }
      case '--model':
        model = value(++i, arg)
        break
      default:
        if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`)
        positional.push(arg)
    }
  }

  const prompt = positional.join(' ').trim() || undefined
  return { storeFile, configFile, cwd, mode, model, newSession, listSessions, listModels, showHelp, sessionId, prompt }
}

export type CliCommand =
  | { type: 'exit' }
  | { type: 'new' }
  | { type: 'sessions' }
  | { type: 'models' }
  | { type: 'help' }
  | { type: 'model'; arg: string }
  | { type: 'mode'; arg: BackendModeId }

/** Slash commands for the interactive prompt. Anything else is a message. */
export function parseCommand(line: string): CliCommand | undefined {
  const [head, ...rest] = line.trim().split(/\s+/)
  const arg = rest.join(' ')
  switch (head) {
    case '/exit':
    case '/quit':
      return { type: 'exit' }
    case '/new':
      return { type: 'new' }
    case '/sessions':
      return { type: 'sessions' }
    case '/models':
      return { type: 'models' }
    case '/model':
      return arg ? { type: 'model', arg } : undefined
    case '/mode':
      if (!isMode(arg)) return undefined
      return { type: 'mode', arg }
    case '/help':
      return { type: 'help' }
    default:
      return undefined
  }
}

export type SessionResolution = { action: 'create' } | { action: 'reuse'; id: string }

/** Pick the thread to talk to: an explicit id must exist, `--new` creates, and
 *  otherwise the most recently updated session is resumed. */
export function resolveSession(sessions: SessionInfo[], opts: { newSession?: boolean; sessionId?: string }): SessionResolution {
  if (opts.newSession) return { action: 'create' }
  if (opts.sessionId) {
    if (!sessions.some((session) => session.id === opts.sessionId)) {
      throw new Error(`Unknown session: ${opts.sessionId}`)
    }
    return { action: 'reuse', id: opts.sessionId }
  }
  const mostRecent = [...sessions].sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))[0]
  return mostRecent ? { action: 'reuse', id: mostRecent.id } : { action: 'create' }
}

const HELP = [
  'lab — a from-scratch coding agent harness',
  '',
  'Usage: lab [options] [prompt...]',
  '  lab                 start an interactive session',
  '  lab "fix the tests" run a single prompt',
  '',
  'Options:',
  '  --new               start a fresh session instead of resuming the last',
  '  --session <id>      talk to a specific saved session',
  '  --sessions          list saved sessions',
  '  --models            list models available on the endpoint',
  '  --mode <ask|auto|accept-edits|plan>  permission mode (ask on a TTY, auto when piped)',
  '  --model <id>        default model',
  '  --store <path>      session store file (default ~/.lab/threads.json)',
  '  --config <path>     model config file (default ~/.lab/config.json)',
  '  --cwd <dir>         working directory for the agent (default current)',
  '  -h, --help          show this help',
  '',
  'Interactive commands: /new /sessions /models /model <id> /mode <m> /help /exit',
  '',
  '  Env: LAB_BASE_URL (default http://localhost:11434/v1), LAB_MODEL, LAB_API_KEY, LAB_CONTEXT_CHARS (default 20000),',
  '       LAB_TOOLS=core (search+edit only, faster on small local models), LAB_MAX_TOOL_ITERATIONS (default 8)',
  '  LAB_PROFILE=local|cloud|go applies tier defaults (go = OpenCode Zen, DeepSeek V4 Flash).',
  '  Keys may live in ~/.lab/.env (LAB_API_KEY=..., LAB_PROFILE=...) instead of your shell profile.'
].join('\n')

function gateSummary(call: LabFunctionCall, args: Record<string, unknown>): string {
  const field = call.name === 'bash' ? 'command' : 'path'
  const value = String(args[field] ?? '').slice(0, 80)
  return value ? `(${field}=${value})` : ''
}

/** Run the CLI to completion. Returns the process exit code. */
export async function runCli(args: CliArgs): Promise<number> {
  mkdirSync(dirname(args.storeFile), { recursive: true })
  // ~/.lab/.env first so a key or profile in the file shapes everything below.
  loadDotEnv()
  applyProfilePresets()
  const config = configFromEnv()
  if (args.model) config.defaultModel = args.model

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  let runningSessionId: string | undefined
  let engine!: LabEngine
  process.on('SIGINT', () => {
    if (runningSessionId) engine.abort(runningSessionId)
    rl.close()
  })

  const sink: EngineSink = {
    onUserMessage: () => {},
    onAssistantMessage: () => {},
    onTextDelta: (_sessionId, _messageId, delta) => process.stdout.write(delta),
    onToolPart: (_sessionId, part) => {
      const tool = part.state?.tool
      if (!tool) return
      const status = part.state?.status ?? 'running'
      process.stdout.write(`\n\x1b[90m[${status}] ${tool}\x1b[0m\n`)
    },
    onTodos: () => {},
    onBusy: () => {},
    onIdle: () => process.stdout.write('\n'),
    onError: (_sessionId, error) => process.stderr.write(`\nerror: ${error}\n`)
  }

  engine = new LabEngine({
    storeFile: args.storeFile,
    configFile: args.configFile,
    config,
    sink,
    gate: {
      request: async (sessionId, call, args: Record<string, unknown>, signal) => {
        const answer = await Promise.race([
          rl.question(`allow ${call.name} ${gateSummary(call, args)}? [y/N/a] `).catch(() => 'deny'),
          new Promise<'deny'>((resolve) => {
            if (signal.aborted) return resolve('deny')
            signal.addEventListener('abort', () => resolve('deny'), { once: true })
          })
        ])
        if (answer === 'deny') return 'deny'
        const choice = answer.trim().toLowerCase()
        if (choice === 'a') {
          engine.store.grantAlways(sessionId, call.name)
          return 'allow'
        }
        return choice.startsWith('y') ? 'allow' : 'deny'
      }
    }
  })

  if (args.showHelp) {
    console.log(HELP)
    rl.close()
    return 0
  }

  const topLevel = engine.store.list().filter((session) => !engine.store.get(session.id)?.parentID)
  if (args.listSessions) {
    for (const session of topLevel) console.log(`${session.id}\t${session.title ?? 'Untitled'}\t${new Date(session.time?.updated ?? 0).toISOString()}`)
    rl.close()
    return 0
  }
  if (args.listModels) {
    const models = await engine.listModels()
    for (const model of models) console.log(model.id)
    rl.close()
    return 0
  }

  const resolved = resolveSession(topLevel, { newSession: args.newSession, sessionId: args.sessionId })
  const session = resolved.action === 'create'
    ? engine.store.create(undefined, args.cwd)
    : engine.store.get(resolved.id)
  engine.store.setDirectory(session.id, args.cwd)
  console.log(`session ${session.id} (${args.cwd})`)
  console.log(`model=${engine.model} tools=${config.tools} ctx=${config.contextChars} iters=${config.maxToolIterations}`)

  const send = async (prompt: string, mode: BackendModeId): Promise<void> => {
    runningSessionId = session.id
    try {
      await engine.sendMessage(session.id, prompt, { mode })
    } finally {
      runningSessionId = undefined
    }
  }

  if (args.prompt !== undefined) {
    await send(args.prompt, args.mode)
    rl.close()
    return 0
  }

  let mode = args.mode
  for (;;) {
    let line: string
    try {
      line = await rl.question('lab> ')
    } catch {
      return 0 // closed by Ctrl+C or EOF
    }
    const command = parseCommand(line)
    if (command) {
      switch (command.type) {
        case 'exit':
          rl.close()
          return 0
        case 'new': {
          const fresh = engine.store.create(undefined, args.cwd)
          engine.store.setDirectory(fresh.id, args.cwd)
          console.log(`session ${fresh.id}`)
          continue
        }
        case 'sessions':
          for (const item of engine.store.list().filter((item) => !engine.store.get(item.id)?.parentID)) {
            console.log(`${item.id}\t${item.title ?? 'Untitled'}`)
          }
          continue
        case 'models': {
          const models = await engine.listModels()
          for (const model of models) console.log(model.id)
          continue
        }
        case 'model':
          engine.selectModel(command.arg)
          console.log(`model ${command.arg}`)
          continue
        case 'mode':
          mode = command.arg
          console.log(`mode ${mode}`)
          continue
        case 'help':
          console.log(HELP)
          continue
      }
      continue
    }
    if (line.trim()) await send(line.trim(), mode)
  }
}