import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
// @ts-expect-error Node's type-stripping test runner needs the extension.
import { runEvalSuite, type EvalRuntime } from './eval-runner.ts'
import type { LabEvalInput, LabEvalObservation } from './lab-eval-runtime.ts'
// @ts-expect-error Node's type-stripping test runner needs the extension.
import { LAB_EVAL_SCENARIOS } from './lab-scenarios.ts'

const scripted: EvalRuntime<LabEvalInput, LabEvalObservation> = {
  id: 'scripted-lab',
  run: async (input, context) => {
    if (context.scenarioId === 'lab.repair-implementation') {
      const path = join(input.workspace, 'math.js')
      writeFileSync(path, readFileSync(path, 'utf8').replace('a - b', 'a + b'))
      return {
        outcome: { status: 'completed' },
        finalText: 'Fixed math.js and verified the test.',
        changedFiles: ['math.js'],
        transcript: [],
        toolCalls: [{ id: 'edit', name: 'edit_file', status: 'completed' }]
      }
    }
    if (context.scenarioId === 'lab.inspect-configuration') {
      return {
        outcome: { status: 'completed' },
        finalText: 'The webhook port is 4528.',
        changedFiles: [],
        transcript: [],
        toolCalls: [{ id: 'read', name: 'read_file', status: 'completed' }]
      }
    }
    return {
      outcome: { status: 'completed' },
      finalText: 'I would inspect README.md and replace the title.',
      changedFiles: [],
      transcript: [],
      toolCalls: [{ id: 'read', name: 'read_file', status: 'completed' }]
    }
  }
}

test('the initial Lab scenarios have deterministic graders and clean fixtures', async () => {
  const report = await runEvalSuite(scripted, LAB_EVAL_SCENARIOS)
  assert.equal(report.summary.total, 3)
  assert.equal(report.summary.passed, 3)
})
