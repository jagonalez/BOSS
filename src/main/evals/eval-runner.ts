export interface EvalAssertion {
  id: string
  passed: boolean
  message: string
  expected?: unknown
  actual?: unknown
}

export interface EvalPrepared<Input> {
  input: Input
  cleanup?: () => void | Promise<void>
}

export interface EvalScenario<Input, Observation> {
  id: string
  name: string
  description: string
  tags?: string[]
  prepare(): EvalPrepared<Input> | Promise<EvalPrepared<Input>>
  grade(input: Input, observation: Observation): EvalAssertion[] | Promise<EvalAssertion[]>
}

export interface EvalRunContext {
  scenarioId: string
  iteration: number
  signal: AbortSignal
}

/** A model or harness adapter. The scenario and grader deliberately know
 * nothing about how the runtime obtains a completion, so the same suite can
 * compare Lab, Pi, or a replay runtime. */
export interface EvalRuntime<Input, Observation> {
  id: string
  run(input: Input, context: EvalRunContext): Promise<Observation>
}

export type EvalCaseStatus = 'passed' | 'failed' | 'error'

export interface EvalCaseResult<Observation = unknown> {
  scenarioId: string
  scenarioName: string
  runtimeId: string
  iteration: number
  status: EvalCaseStatus
  startedAt: number
  durationMs: number
  assertions: EvalAssertion[]
  observation?: Observation
  error?: string
}

export interface EvalReport<Observation = unknown> {
  version: 1
  runtimeId: string
  startedAt: number
  finishedAt: number
  repeats: number
  results: Array<EvalCaseResult<Observation>>
  summary: {
    passed: number
    failed: number
    errors: number
    total: number
    passRate: number
  }
}

export interface EvalRunOptions {
  repeats?: number
  timeoutMs?: number
  failFast?: boolean
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback
}

async function runOne<Input, Observation>(
  runtime: EvalRuntime<Input, Observation>,
  scenario: EvalScenario<Input, Observation>,
  iteration: number,
  timeoutMs: number
): Promise<EvalCaseResult<Observation>> {
  const startedAt = Date.now()
  let prepared: EvalPrepared<Input> | undefined
  const controller = new AbortController()
  let rejectTimeout: (error: Error) => void = () => {}
  const timeout = new Promise<never>((_resolve, reject) => { rejectTimeout = reject })
  const timer = setTimeout(() => {
    const error = new Error(`Eval timed out after ${timeoutMs}ms.`)
    controller.abort(error)
    rejectTimeout(error)
  }, timeoutMs)
  try {
    prepared = await scenario.prepare()
    const observation = await Promise.race([
      runtime.run(prepared.input, {
        scenarioId: scenario.id,
        iteration,
        signal: controller.signal
      }),
      timeout
    ])
    if (controller.signal.aborted) throw controller.signal.reason
    const assertions = await scenario.grade(prepared.input, observation)
    if (assertions.length === 0) throw new Error(`Eval scenario "${scenario.id}" has no assertions.`)
    return {
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      runtimeId: runtime.id,
      iteration,
      status: assertions.every((assertion) => assertion.passed) ? 'passed' : 'failed',
      startedAt,
      durationMs: Date.now() - startedAt,
      assertions,
      observation
    }
  } catch (error) {
    return {
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      runtimeId: runtime.id,
      iteration,
      status: 'error',
      startedAt,
      durationMs: Date.now() - startedAt,
      assertions: [],
      error: errorText(error)
    }
  } finally {
    clearTimeout(timer)
    await prepared?.cleanup?.()
  }
}

export async function runEvalSuite<Input, Observation>(
  runtime: EvalRuntime<Input, Observation>,
  scenarios: Array<EvalScenario<Input, Observation>>,
  options: EvalRunOptions = {}
): Promise<EvalReport<Observation>> {
  const startedAt = Date.now()
  const repeats = positiveInteger(options.repeats, 1)
  const timeoutMs = positiveInteger(options.timeoutMs, 120_000)
  const results: Array<EvalCaseResult<Observation>> = []
  let stopped = false
  for (let iteration = 1; iteration <= repeats && !stopped; iteration += 1) {
    for (const scenario of scenarios) {
      const result = await runOne(runtime, scenario, iteration, timeoutMs)
      results.push(result)
      if (options.failFast && result.status !== 'passed') {
        stopped = true
        break
      }
    }
  }
  const passed = results.filter((result) => result.status === 'passed').length
  const failed = results.filter((result) => result.status === 'failed').length
  const errors = results.filter((result) => result.status === 'error').length
  return {
    version: 1,
    runtimeId: runtime.id,
    startedAt,
    finishedAt: Date.now(),
    repeats,
    results,
    summary: {
      passed,
      failed,
      errors,
      total: results.length,
      passRate: results.length === 0 ? 0 : passed / results.length
    }
  }
}

export function formatEvalReport(report: EvalReport): string {
  const lines: string[] = []
  for (const result of report.results) {
    const mark = result.status === 'passed' ? 'PASS' : result.status === 'failed' ? 'FAIL' : 'ERROR'
    lines.push(`${mark} ${result.scenarioId} #${result.iteration} (${result.durationMs}ms)`)
    if (result.error) lines.push(`  ${result.error}`)
    for (const assertion of result.assertions.filter((item) => !item.passed)) {
      lines.push(`  - ${assertion.id}: ${assertion.message}`)
    }
  }
  const percent = Math.round(report.summary.passRate * 100)
  lines.push('')
  lines.push(`${report.runtimeId}: ${report.summary.passed}/${report.summary.total} passed (${percent}%), ${report.summary.errors} errors`)
  return lines.join('\n')
}

export function assertion(
  id: string,
  passed: boolean,
  message: string,
  detail: { expected?: unknown; actual?: unknown } = {}
): EvalAssertion {
  return { id, passed, message, ...detail }
}
