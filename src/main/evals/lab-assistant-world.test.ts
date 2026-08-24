import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Node's type-stripping test runner needs the extension.
import { runEvalSuite, type EvalRuntime } from './eval-runner.ts'
// @ts-expect-error Node's type-stripping test runner needs the extension.
import { LAB_ASSISTANT_EVAL_SCENARIOS } from './lab-assistant-scenarios.ts'
import type { LabAssistantEvalInput, LabAssistantEvalObservation } from './lab-assistant-runtime.ts'
// @ts-expect-error Node's type-stripping test runner needs the extension.
import { LabAssistantWorld } from './lab-assistant-world.ts'

function emptyLab(): LabAssistantEvalObservation['lab'] {
  return {
    outcome: { status: 'completed' },
    finalText: 'Done.',
    toolCalls: [],
    changedFiles: [],
    transcript: []
  }
}

const scripted: EvalRuntime<LabAssistantEvalInput, LabAssistantEvalObservation> = {
  id: 'scripted-lab-assistant',
  run: async (input, context) => {
    input.world.execute('lab_assistant_state', {})
    if (context.scenarioId === 'lab-assistant.ambiguous-merge-order') {
      input.world.execute('lab_assistant_ask_user', {
        question: 'Which ready pull request should merge first?',
        options: ['PR #21', 'PR #22']
      })
    } else if (context.scenarioId === 'lab-assistant.route-merge-conflict') {
      input.world.execute('lab_assistant_message_agent', {
        agent_id: 'agent-codex',
        message: 'PR #22 now has a merge conflict after PR #21 merged. Rebase it and resolve the conflict.'
      })
    } else {
      input.world.execute('lab_assistant_prepare_release', {
        project_id: 'boss',
        channel: 'stable',
        bump: 'patch'
      })
      input.world.execute('lab_assistant_ask_user', {
        question: 'Preflight passed. Approve publishing the stable patch release?',
        options: ['Approve', 'Cancel']
      })
    }
    return { lab: emptyLab(), state: input.world.snapshot(), actions: input.world.actions() }
  }
}

test('simulated releases cannot dispatch before user approval', () => {
  const world = new LabAssistantWorld({ projects: [{ id: 'boss', name: 'BOSS' }] })
  const prepared = world.execute('lab_assistant_prepare_release', {
    project_id: 'boss', channel: 'stable', bump: 'patch'
  }) as { id: string }
  assert.throws(() => world.execute('lab_assistant_dispatch_release', { release_id: prepared.id }), /approval/)
  world.approveRelease(prepared.id)
  world.execute('lab_assistant_dispatch_release', { release_id: prepared.id })
  assert.equal(world.snapshot().releases[0].status, 'dispatched')
})

test('the initial Lab Assistant scenarios grade durable actions and final state', async () => {
  const report = await runEvalSuite(scripted, LAB_ASSISTANT_EVAL_SCENARIOS)
  assert.equal(report.summary.total, 3)
  assert.equal(report.summary.passed, 3)
})
