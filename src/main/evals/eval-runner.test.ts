import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Node's type-stripping test runner needs the extension.
import { assertion, formatEvalReport, runEvalSuite, type EvalRuntime, type EvalScenario } from './eval-runner.ts'

interface Input { value: number; cleaned: { value: boolean } }
interface Observation { doubled: number }

function scenario(cleaned: { value: boolean }, passing = true): EvalScenario<Input, Observation> {
  return {
    id: 'double',
    name: 'Double a number',
    description: 'runner fixture',
    prepare: () => ({ input: { value: 2, cleaned }, cleanup: () => { cleaned.value = true } }),
    grade: (_input, observation) => [
      assertion('value', passing && observation.doubled === 4, 'the runtime should double the input')
    ]
  }
}

const runtime: EvalRuntime<Input, Observation> = {
  id: 'fixture',
  run: async (input) => ({ doubled: input.value * 2 })
}

test('runs, grades, repeats, and cleans up scenarios', async () => {
  const cleaned = { value: false }
  const report = await runEvalSuite(runtime, [scenario(cleaned)], { repeats: 2 })
  assert.equal(cleaned.value, true)
  assert.equal(report.results.length, 2)
  assert.equal(report.summary.passed, 2)
  assert.equal(report.summary.passRate, 1)
  assert.match(formatEvalReport(report), /2\/2 passed/)
})

test('records failed assertions separately from runtime errors', async () => {
  const cleaned = { value: false }
  const failed = await runEvalSuite(runtime, [scenario(cleaned, false)])
  assert.equal(failed.results[0].status, 'failed')
  assert.equal(failed.summary.failed, 1)

  const broken: EvalRuntime<Input, Observation> = {
    id: 'broken',
    run: async () => { throw new Error('provider unavailable') }
  }
  const errored = await runEvalSuite(broken, [scenario(cleaned)])
  assert.equal(errored.results[0].status, 'error')
  assert.match(errored.results[0].error ?? '', /provider unavailable/)
})

test('fail-fast stops before another scenario or repetition', async () => {
  const cleaned = { value: false }
  const report = await runEvalSuite(runtime, [scenario(cleaned, false), scenario(cleaned)], {
    repeats: 3,
    failFast: true
  })
  assert.equal(report.results.length, 1)
})

test('enforces the timeout even when a runtime ignores the abort signal', async () => {
  const cleaned = { value: false }
  const stalled: EvalRuntime<Input, Observation> = {
    id: 'stalled',
    run: () => new Promise(() => {})
  }
  const report = await runEvalSuite(stalled, [scenario(cleaned)], { timeoutMs: 20 })
  assert.equal(report.results[0].status, 'error')
  assert.match(report.results[0].error ?? '', /timed out/)
  assert.equal(cleaned.value, true)
})
