import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BackendModeId } from '../../shared/backend'
import type { MessageWithParts } from '../../shared/opencode'
// @ts-expect-error Node's type-stripping runner needs explicit source extensions.
import { LabEngine, type ExternalTools, type LabEngineConfig, type RunOutcome } from '../backend/lab-engine.ts'
import type { EvalRunContext, EvalRuntime } from './eval-runner.ts'

export interface LabEvalInput {
  workspace: string
  prompt: string
  mode?: BackendModeId
  context?: string
  toolSet?: LabEngineConfig['tools']
  externalTools?: ExternalTools
}

export interface LabEvalToolCall {
  id: string
  name: string
  status: 'completed' | 'error'
  input?: unknown
  output?: unknown
}

export interface LabEvalTranscriptMessage {
  role: 'user' | 'assistant'
  text: string
}

export interface LabEvalObservation {
  outcome: RunOutcome
  finalText: string
  toolCalls: LabEvalToolCall[]
  changedFiles: string[]
  transcript: LabEvalTranscriptMessage[]
}

export interface LabEvalRuntimeOptions {
  baseUrl: string
  model: string
  apiKey?: string
  contextChars?: number
  maxToolIterations?: number
  /** Permission prompts cannot wait for a person in an eval. Auto mode still
   * follows its normal policy; this controls calls that reach the interactive gate. */
  gate?: 'allow' | 'deny'
}

function messageText(message: MessageWithParts): string {
  return message.parts
    .filter((part) => part.type === 'text' || part.type === 'compaction')
    .map((part) => part.text ?? '')
    .filter(Boolean)
    .join('\n')
}

function finalAssistantText(messages: MessageWithParts[]): string {
  for (const message of [...messages].reverse()) {
    if (message.info.role !== 'assistant') continue
    const text = messageText(message).trim()
    if (text) return text
  }
  return ''
}

function toolCalls(messages: MessageWithParts[]): LabEvalToolCall[] {
  const calls: LabEvalToolCall[] = []
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== 'tool') continue
      const status = part.state?.status
      if (status !== 'completed' && status !== 'error') continue
      calls.push({
        id: part.id,
        name: part.state?.tool ?? '',
        status,
        input: part.state?.input,
        output: part.state?.output
      })
    }
  }
  return calls
}

/** Real Lab adapter for the generic eval runner. Each case receives a fresh
 * engine and session while the model endpoint can be local or remote. */
export class LabEvalRuntime implements EvalRuntime<LabEvalInput, LabEvalObservation> {
  readonly id: string
  private readonly options: LabEvalRuntimeOptions

  constructor(options: LabEvalRuntimeOptions) {
    this.options = options
    this.id = `lab:${options.model}`
  }

  async run(input: LabEvalInput, context: EvalRunContext): Promise<LabEvalObservation> {
    const stateDirectory = mkdtempSync(join(tmpdir(), 'boss-lab-eval-state-'))
    const engine = new LabEngine({
      storeFile: join(stateDirectory, 'threads.json'),
      configFile: join(stateDirectory, 'config.json'),
      config: {
        baseUrl: this.options.baseUrl,
        apiKey: this.options.apiKey,
        defaultModel: this.options.model,
        contextChars: this.options.contextChars ?? 80_000,
        maxToolIterations: this.options.maxToolIterations ?? 32,
        tools: input.toolSet ?? 'all'
      },
      gate: { request: async () => this.options.gate ?? 'deny' },
      externalTools: input.externalTools
    })
    const session = engine.store.create(`Eval · ${context.scenarioId}`, input.workspace)
    const abort = (): void => engine.abort(session.id)
    context.signal.addEventListener('abort', abort, { once: true })
    try {
      const outcome = await engine.sendMessage(session.id, input.prompt, {
        mode: input.mode ?? 'auto',
        model: this.options.model,
        context: input.context,
        baseUrl: this.options.baseUrl,
        apiKey: this.options.apiKey
      })
      const messages = engine.store.messages(session.id)
      const diff = await engine.gitDiff(input.workspace).catch(() => [])
      return {
        outcome,
        finalText: finalAssistantText(messages),
        toolCalls: toolCalls(messages),
        changedFiles: diff.map((file) => file.path).sort(),
        transcript: messages.map((message) => ({ role: message.info.role, text: messageText(message) }))
      }
    } finally {
      context.signal.removeEventListener('abort', abort)
      engine.abort(session.id)
      rmSync(stateDirectory, { recursive: true, force: true })
    }
  }
}
