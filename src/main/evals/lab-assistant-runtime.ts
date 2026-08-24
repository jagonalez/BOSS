import type { EvalRunContext, EvalRuntime } from './eval-runner.ts'
// @ts-expect-error Node's type-stripping runner needs explicit source extensions.
import { LabEvalRuntime, type LabEvalInput, type LabEvalObservation } from './lab-eval-runtime.ts'
// @ts-expect-error Node's type-stripping runner needs explicit source extensions.
import { LAB_ASSISTANT_EVAL_TOOLS, LabAssistantWorld, type LabAssistantAction, type LabAssistantWorldState } from './lab-assistant-world.ts'

export interface LabAssistantEvalInput {
  lab: LabEvalInput
  world: LabAssistantWorld
}

export interface LabAssistantEvalObservation {
  lab: LabEvalObservation
  state: LabAssistantWorldState
  actions: LabAssistantAction[]
}

/** Runs Lab Assistant prompts through the current Lab harness while every BOSS
 * action is contained in a simulated world. Other runtimes can implement the
 * same generic interface and run the exact same scenarios later. */
export class LabAssistantEvalRuntime implements EvalRuntime<LabAssistantEvalInput, LabAssistantEvalObservation> {
  readonly id: string
  private readonly lab: LabEvalRuntime

  constructor(lab: LabEvalRuntime) {
    this.lab = lab
    this.id = `lab-assistant:${lab.id}`
  }

  async run(input: LabAssistantEvalInput, context: EvalRunContext): Promise<LabAssistantEvalObservation> {
    const externalTools = {
      definitions: () => LAB_ASSISTANT_EVAL_TOOLS,
      execute: async (name: string, args: Record<string, unknown>) => {
        const result = input.world.execute(name, args)
        return JSON.stringify(result, null, 2)
      }
    }
    const observation = await this.lab.run({
      ...input.lab,
      toolSet: 'assistant',
      externalTools,
      context: [
        'You are being evaluated as Lab Assistant, the persistent orchestration assistant in BOSS.',
        'BOSS state is authoritative. Read it with lab_assistant_state and use the typed Lab Assistant tools for every durable action.',
        'Do not substitute prose for an inbox question or action that has a tool.'
      ].join(' ')
    }, context)
    return {
      lab: observation,
      state: input.world.snapshot(),
      actions: input.world.actions()
    }
  }
}
