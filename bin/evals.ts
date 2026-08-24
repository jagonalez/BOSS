#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
// @ts-expect-error Node's type-stripping runner needs explicit source extensions.
import { configFromEnv, loadDotEnv } from '../src/main/backend/lab-config.ts'
// @ts-expect-error Node's type-stripping runner needs explicit source extensions.
import { formatEvalReport, runEvalSuite } from '../src/main/evals/eval-runner.ts'
// @ts-expect-error Node's type-stripping runner needs explicit source extensions.
import { LabEvalRuntime } from '../src/main/evals/lab-eval-runtime.ts'
// @ts-expect-error Node's type-stripping runner needs explicit source extensions.
import { LAB_EVAL_SCENARIOS } from '../src/main/evals/lab-scenarios.ts'
// @ts-expect-error Node's type-stripping runner needs explicit source extensions.
import { LabAssistantEvalRuntime } from '../src/main/evals/lab-assistant-runtime.ts'
// @ts-expect-error Node's type-stripping runner needs explicit source extensions.
import { LAB_ASSISTANT_EVAL_SCENARIOS } from '../src/main/evals/lab-assistant-scenarios.ts'

interface Args {
  suite: 'lab' | 'lab-assistant'
  list: boolean
  scenario?: string
  repeats: number
  timeoutMs: number
  model?: string
  baseUrl?: string
  output?: string
}

const HELP = `BOSS Lab evals

Usage:
  npm run eval:lab -- [options]
  npm run eval:assistant -- [options]

Options:
  --list                 List scenarios without calling a model
  --scenario <id>        Run one scenario
  --repeats <count>      Repeat each scenario (default 1)
  --timeout-ms <ms>      Per-case timeout (default 120000)
  --model <id>           Override LAB_MODEL
  --base-url <url>       Override LAB_BASE_URL
  --output <path>        Write the full JSON trace report
  -h, --help             Show this help

Credentials are read from LAB_API_KEY or ~/.lab/.env and are never accepted as
arguments, keeping them out of shell history and process listings.
`

function valueAfter(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`)
  return value
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer.`)
  return parsed
}

export function parseEvalArgs(argv: string[]): Args | { help: true } {
  const suiteArg = argv[0]
  if (suiteArg === '-h' || suiteArg === '--help') return { help: true }
  if (suiteArg !== 'lab' && suiteArg !== 'lab-assistant') throw new Error('Choose the lab or lab-assistant suite.')
  const result: Args = { suite: suiteArg, list: false, repeats: 1, timeoutMs: 120_000 }
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '-h' || arg === '--help') return { help: true }
    if (arg === '--list') result.list = true
    else if (arg === '--scenario') result.scenario = valueAfter(argv, index++, arg)
    else if (arg === '--repeats') result.repeats = positiveInteger(valueAfter(argv, index++, arg), arg)
    else if (arg === '--timeout-ms') result.timeoutMs = positiveInteger(valueAfter(argv, index++, arg), arg)
    else if (arg === '--model') result.model = valueAfter(argv, index++, arg)
    else if (arg === '--base-url') result.baseUrl = valueAfter(argv, index++, arg)
    else if (arg === '--output') result.output = valueAfter(argv, index++, arg)
    else throw new Error(`Unknown option: ${arg}`)
  }
  return result
}

async function main(): Promise<number> {
  const args = parseEvalArgs(process.argv.slice(2))
  if ('help' in args) {
    process.stdout.write(HELP)
    return 0
  }
  const all = args.suite === 'lab' ? LAB_EVAL_SCENARIOS : LAB_ASSISTANT_EVAL_SCENARIOS
  const scenarios = args.scenario ? all.filter((scenario) => scenario.id === args.scenario) : all
  if (scenarios.length === 0) throw new Error(`No scenario matches ${args.scenario}. Use --list to see scenario ids.`)
  if (args.list) {
    for (const scenario of scenarios) {
      process.stdout.write(`${scenario.id}\t${scenario.name}\n`)
      process.stdout.write(`  ${scenario.description}\n`)
    }
    return 0
  }

  loadDotEnv()
  const config = configFromEnv()
  const lab = new LabEvalRuntime({
    baseUrl: args.baseUrl ?? config.baseUrl,
    model: args.model ?? config.defaultModel,
    apiKey: config.apiKey,
    contextChars: config.contextChars,
    maxToolIterations: config.maxToolIterations
  })
  const options = { repeats: args.repeats, timeoutMs: args.timeoutMs }
  const report = args.suite === 'lab'
    ? await runEvalSuite(lab, LAB_EVAL_SCENARIOS.filter((scenario) => scenarios.some((selected) => selected.id === scenario.id)), options)
    : await runEvalSuite(new LabAssistantEvalRuntime(lab), LAB_ASSISTANT_EVAL_SCENARIOS.filter((scenario) => scenarios.some((selected) => selected.id === scenario.id)), options)
  process.stdout.write(`${formatEvalReport(report)}\n`)
  if (args.output) writeFileSync(args.output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  return report.summary.failed === 0 && report.summary.errors === 0 ? 0 : 1
}

const code = await main().catch((error) => {
  process.stderr.write(`evals: ${error instanceof Error ? error.message : String(error)}\n`)
  return 1
})
process.exit(code)
