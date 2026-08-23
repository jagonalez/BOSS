import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { BackendModeId } from '@shared/backend'
import type { FileContent, FileDiff, FileNode, MessageInfo, MessageWithParts, Part, Todo } from '@shared/opencode'
// The explicit extensions keep this module executable under Node's type-stripping test runner.
// @ts-expect-error Application builds use bundler resolution.
import { LabSessionStore } from './lab-session-store.ts'
// @ts-expect-error Application builds use bundler resolution.
import { listModels, streamChatCompletion } from './lab-client.ts'
// @ts-expect-error Application builds use bundler resolution.
import { cropHistory, openAiMessagesFromHistory, type LabChatMessage } from './lab-openai.ts'
// @ts-expect-error Node's type-stripping tests require the explicit extension.
import { compactionNotice } from './compaction-events.ts'
// @ts-expect-error Application builds use bundler resolution.
import { parseToolArguments, type LabFunctionCall } from './lab-tool-call.ts'
// @ts-expect-error Application builds use bundler resolution.
import { ASSISTANT_TOOL_DEFINITIONS, CORE_TOOL_DEFINITIONS, FileSnapshots, LAB_TOOL_DEFINITIONS, alwaysGrantsAllow, fileTreeFromPaths, inferToolName, parseGitStatus, parseNumStat, permissionForTool, resolveInCwd, resolveToolGate, runGit, runTool, walkFiles, type LabToolFunction } from './lab-tools.ts'
// @ts-expect-error Application builds use bundler resolution.
import { isOrchestrationTool, LabOrchestrator } from './lab-orchestrator.ts'

export interface LabEngineConfig {
  baseUrl: string
  apiKey?: string
  defaultModel: string
  contextChars: number
  maxToolIterations: number
  tools: 'core' | 'all' | 'assistant'
}

/** Where the engine's own progress is published. A transport maps these to its
 *  native events — BOSS emits EventMessages, a CLI prints to stdout, an ACP
 *  server writes stream-json. Sub-agent turns run with a no-op sink.
 *
 *  `onTextDelta` carries only the newly generated text since the previous call;
 *  a transport that shows the whole reply (like BOSS's part replacement) must
 *  accumulate it itself. */
/** Tools the engine does not implement itself, supplied by the host. BOSS uses
 *  this for the thread bus, so an assistant can see and drive sibling threads;
 *  the CLI and ACP server pass nothing and the tools simply do not appear.
 *
 *  Kept as an injected provider rather than an MCP client so the engine stays
 *  transport-agnostic: the host already owns the thread bus and can hand over
 *  definitions plus one execute function. */
export interface ExternalTools {
  definitions(): LabToolFunction[]
  /** `sessionId` identifies the calling thread to the host, which resolves it
   *  to a BOSS thread and applies that project's own sharing policy. */
  execute(name: string, args: Record<string, unknown>, sessionId: string): Promise<string>
}

export interface EngineSink {
  onUserMessage(sessionId: string, message: MessageWithParts): void
  onAssistantMessage(sessionId: string, message: MessageWithParts): void
  onTextDelta(sessionId: string, messageId: string, text: string): void
  onReasoningDelta(sessionId: string, messageId: string, text: string): void
  onToolPart(sessionId: string, part: Part): void
  onTodos(sessionId: string, todos: Todo[]): void
  onBusy(sessionId: string): void
  onIdle(sessionId: string): void
  onError(sessionId: string, error: string): void
}

/** The one interactive seam. Called only when the mode and stored grants say
 *  "ask"; the transport prompts the user and returns allow or deny. `signal` is
 *  the run's abort signal, so an interruption settles a pending prompt. */
export interface EngineGate {
  request(sessionId: string, call: LabFunctionCall, args: Record<string, unknown>, signal: AbortSignal): Promise<'allow' | 'deny'>
}

export interface RunOutcome {
  status: 'completed' | 'error' | 'interrupted'
  error?: string
}

/** How many of the newest messages survive a compaction; everything older is
 *  replaced by a summary so long sessions stop drifting. */
const COMPACT_KEEP_TAIL = 6

const COMPACTION_PROMPT = [
  'You are a conversation summarizer for a coding session.',
  'Compress the older part of the session into a concise handoff that keeps: the original request, decisions made, files touched, commands run, and any open questions or blockers.',
  'Output only the summary, with no preamble.'
].join('\n')

const noopSink: EngineSink = {
  onUserMessage() {},
  onAssistantMessage() {},
  onTextDelta() {},
  onReasoningDelta() {},
  onToolPart() {},
  onTodos() {},
  onBusy() {},
  onIdle() {},
  onError() {}
}

function toolRunningPart(sessionId: string, messageId: string, call: LabFunctionCall, args: Record<string, unknown>): Part {
  return {
    id: call.id,
    type: 'tool',
    sessionID: sessionId,
    messageID: messageId,
    state: { status: 'running', tool: call.name, input: args }
  }
}

interface TurnContext {
  mode: BackendModeId
  model: string
  baseUrl: string
  apiKey?: string
  cwd: string
  signal: AbortSignal
}

export interface LabEndpointConfig {
  baseUrl: string
  apiKey?: string
}

/** The Lab agent harness: sessions, a streaming OpenAI-compatible chat client,
 *  a permission-aware tool loop, and sub-agent orchestration. It knows nothing
 *  about BOSS or any client — everything it produces goes out through the sink,
 *  and every interactive decision comes back through the gate. Built only on
 *  fetch and the Node standard library. */
export class LabEngine {
  readonly store: LabSessionStore
  private readonly configFile: string
  private readonly config: LabEngineConfig
  private readonly sink: EngineSink
  private readonly gate: EngineGate
  private readonly externalTools?: ExternalTools
  private readonly orchestrator: LabOrchestrator
  private readonly modes = new Map<string, BackendModeId>()
  private readonly running = new Map<string, AbortController>()
  private readonly snapshots = new FileSnapshots()
  /** Messages steered into a session while its run is in flight. Folded into
   *  the model's history between tool-loop rounds. */
  private readonly pendingSteers = new Map<string, string[]>()
  private readonly endpointBySession = new Map<string, LabEndpointConfig>()
  private readonly tools: LabToolFunction[]
  private selectedModel: string

  constructor(options: {
    storeFile: string
    configFile: string
    config: LabEngineConfig
    gate: EngineGate
    sink?: EngineSink
    externalTools?: ExternalTools
  }) {
    this.store = new LabSessionStore(options.storeFile)
    this.configFile = options.configFile
    this.config = options.config
    this.gate = options.gate
    this.externalTools = options.externalTools
    this.sink = options.sink ?? noopSink
    const builtin =
      options.config.tools === 'core'
        ? CORE_TOOL_DEFINITIONS
        : options.config.tools === 'assistant'
          ? ASSISTANT_TOOL_DEFINITIONS
          : LAB_TOOL_DEFINITIONS
    this.tools = [...builtin, ...(options.externalTools?.definitions() ?? [])]
    this.selectedModel = this.config.defaultModel
    try {
      const stored = JSON.parse(readFileSync(this.configFile, 'utf8')) as { model?: string }
      if (typeof stored.model === 'string' && stored.model) this.selectedModel = stored.model
    } catch {
      /* env default applies on first launch */
    }
    this.orchestrator = new LabOrchestrator(this.store, (request) => this.runTurn({
      sessionId: request.sessionId,
      prompt: request.instruction,
      mode: 'auto',
      model: request.model,
      cwd: request.cwd,
      controller: request.controller,
      signal: request.signal,
      emitStatus: false,
      context: request.context,
      ...this.endpointForChild(request.sessionId)
    }))
  }

  get model(): string { return this.selectedModel }

  /** Reconcile sub-agents left running after a crash, and drop the shutdown
   *  state. Cheap enough to call on every start. */
  start(): void {
    this.orchestrator.reconcileStale()
  }

  stop(): void {
    for (const controller of this.running.values()) controller.abort()
    this.running.clear()
    this.endpointBySession.clear()
    this.orchestrator.stop()
  }

  /** Abort a session's run and stop everything it spawned. */
  disposeSession(sessionId: string): void {
    this.running.get(sessionId)?.abort()
    this.orchestrator.dispose(sessionId)
    this.endpointBySession.delete(sessionId)
  }

  async checkHealth(endpoint: LabEndpointConfig = this.config): Promise<boolean> {
    try {
      const response = await fetch(`${endpoint.baseUrl}/models`, {
        method: 'GET',
        headers: endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : undefined,
        signal: AbortSignal.timeout(3_000)
      })
      const healthy = response.ok
      if (response.body) await response.body.cancel().catch(() => {})
      return healthy
    } catch {
      return false
    }
  }

  async listModels(endpoint: LabEndpointConfig = this.config): Promise<Array<{ id: string; name?: string; provider?: string; source?: 'local' | 'cloud' }>> {
    return listModels(endpoint.baseUrl, endpoint.apiKey)
  }

  private endpointForChild(sessionId: string): LabEndpointConfig {
    let parentId = this.store.get(sessionId).parentID
    while (parentId) {
      const endpoint = this.endpointBySession.get(parentId)
      if (endpoint) return endpoint
      parentId = this.store.get(parentId).parentID
    }
    return this.config
  }

  selectModel(modelId: string): void {
    if (!modelId) return
    this.selectedModel = modelId
    try {
      // The BOSS connection form owns the endpoint in this same lightweight
      // config file. Preserve fields it wrote when a thread changes models.
      let existing: Record<string, unknown> = {}
      try {
        const parsed = JSON.parse(readFileSync(this.configFile, 'utf8'))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>
      } catch {
        /* first saved model */
      }
      writeFileSync(this.configFile, JSON.stringify({ ...existing, model: this.selectedModel }, null, 2))
    } catch {
      /* model still applies for this session */
    }
  }

  setPermissionMode(sessionId: string, mode: BackendModeId): void {
    this.modes.set(sessionId, mode)
  }

  async sendMessage(sessionId: string, prompt: string, options?: {
    mode?: BackendModeId
    model?: string
    context?: string
    baseUrl?: string
    apiKey?: string
  }): Promise<RunOutcome> {
    if (this.running.has(sessionId)) throw new Error('Lab is already working on this thread.')
    const mode = options?.mode ?? this.modes.get(sessionId) ?? 'ask'
    if (options?.mode) this.modes.set(sessionId, options.mode)
    if (options?.model) this.selectedModel = options.model
    const model = options?.model ?? this.selectedModel
    const record = this.store.get(sessionId)
    const cwd = record.directory || globalThis.process.cwd()
    const controller = new AbortController()
    const endpoint = {
      baseUrl: options?.baseUrl ?? this.config.baseUrl,
      apiKey: options?.baseUrl ? options.apiKey : this.config.apiKey
    }
    this.endpointBySession.set(sessionId, endpoint)
    return this.runTurn({ sessionId, prompt, mode, model, cwd, controller, emitStatus: true, context: options?.context, ...endpoint })
  }

  /** Interrupt a session's run. Gate prompts settle through the abort signal
   *  that was handed to the gate. */
  abort(sessionId: string): void {
    this.running.get(sessionId)?.abort()
  }

  /** Steer a running session mid-turn. The message is persisted immediately so
   *  it survives, and folded into the model's next request inside the current
   *  tool loop, so the agent reacts to it before answering. The transport is
   *  responsible for echoing it to the user; the engine does not emit it. */
  steer(sessionId: string, prompt: string): void {
    const record = this.store.get(sessionId)
    const userId = randomUUID()
    record.messages.push({
      info: { id: userId, sessionID: sessionId, role: 'user', time: { created: Date.now() } },
      parts: [{ id: `${userId}-text`, type: 'text', sessionID: sessionId, messageID: userId, text: prompt }]
    })
    this.store.setMessages(sessionId, record.messages)
    if (this.running.has(sessionId)) {
      const pending = this.pendingSteers.get(sessionId) ?? []
      pending.push(prompt)
      this.pendingSteers.set(sessionId, pending)
    }
  }

  /** Summarize the older turns of a session and replace them with one
   *  compaction message, keeping the newest messages intact. Long sessions stop
   *  drifting and the next request starts from a tighter context. */
  async compact(sessionId: string, model?: string, endpoint: LabEndpointConfig = this.config): Promise<void> {
    const messages = this.store.messages(sessionId)
    if (messages.length <= COMPACT_KEEP_TAIL + 1) return
    const cutoff = messages.length - COMPACT_KEEP_TAIL
    const older = messages.slice(0, cutoff)
    const tail = messages.slice(cutoff)
    const summary = await this.summarize(openAiMessagesFromHistory(older, COMPACTION_PROMPT), model, endpoint)
    const id = `compaction-${randomUUID()}`
    const compaction: MessageWithParts = {
      info: { id, sessionID: sessionId, role: 'assistant', time: { created: Date.now() } },
      parts: [{ id: `${id}-text`, type: 'compaction', sessionID: sessionId, messageID: id, text: summary || '(no summary)' }]
    }
    this.store.setMessages(sessionId, [compaction, ...tail])
    this.sink.onAssistantMessage(sessionId, compaction)
  }

  private async summarize(history: LabChatMessage[], model?: string, endpoint: LabEndpointConfig = this.config): Promise<string> {
    const result = await streamChatCompletion({
      baseUrl: endpoint.baseUrl,
      model: model ?? this.selectedModel,
      messages: history,
      apiKey: endpoint.apiKey,
      signal: AbortSignal.timeout(120_000)
    })
    return result.content.trim()
  }

  /** Working-tree changes as BOSS FileDiffs. Sets both the `original`/`content`
   *  and `before`/`after` conventions so any consumer can render a unified
   *  diff. */
  async gitDiff(base: string): Promise<FileDiff[]> {
    const cwd = resolve(base)
    const status = await runGit(['status', '--porcelain'], cwd)
    const entries = parseGitStatus(status.stdout)
    if (entries.length === 0) return []

    const stats = new Map<string, { additions: number; deletions: number }>()
    const worktree = await runGit(['diff', '--numstat'], cwd)
    const staged = await runGit(['diff', '--cached', '--numstat'], cwd)
    for (const entry of [...parseNumStat(worktree.stdout), ...parseNumStat(staged.stdout)]) {
      const current = stats.get(entry.path) ?? { additions: 0, deletions: 0 }
      stats.set(entry.path, {
        additions: current.additions + entry.additions,
        deletions: current.deletions + entry.deletions
      })
    }

    const diffs: FileDiff[] = []
    for (const entry of entries) {
      let before = ''
      let after = ''
      if (entry.worktree !== 'D' && entry.index !== 'D') {
        try { after = readFileSync(resolveInCwd(cwd, entry.path), 'utf8') } catch { /* deleted or moved */ }
      }
      const isUntracked = entry.index === '?' || entry.worktree === '?'
      if (!isUntracked) {
        const head = await runGit(['show', `HEAD:${entry.path}`], cwd)
        before = head.code === 0 ? head.stdout : ''
      }
      const stat = stats.get(entry.path) ?? { additions: 0, deletions: 0 }
      diffs.push({
        path: entry.path,
        status: entry.worktree === 'D' || entry.index === 'D' ? 'deleted' : isUntracked ? 'added' : 'modified',
        additions: stat.additions,
        deletions: stat.deletions,
        original: before,
        content: after,
        before,
        after
      })
    }
    return diffs
  }

  /** Nested file tree under `base`, optionally scoped to a subdirectory. */
  async fileTree(base: string, path?: string): Promise<FileNode[]> {
    const cwd = resolve(base)
    let root = cwd
    if (path) {
      try { root = resolveInCwd(cwd, path) } catch { return [] }
    }
    const files = walkFiles(root)
    return fileTreeFromPaths(cwd, files)
  }

  /** Read a file inside `base`, refusing paths that escape it. */
  async fileContentAt(base: string, path: string): Promise<FileContent> {
    const cwd = resolve(base)
    const file = resolveInCwd(cwd, path)
    return { path, content: readFileSync(file, 'utf8') }
  }

  /** One user turn: echo the prompt, mark busy, run the agent loop, settle
   *  with idle or an error. Shared by client turns (emitStatus true) and
   *  internal sub-agents (emitStatus false — transcripts still persist so the
   *  parent can collect the summary). */
  private async runTurn(options: {
    sessionId: string
    prompt: string
    mode: BackendModeId
    model: string
    cwd: string
    controller: AbortController
    signal?: AbortSignal
    emitStatus: boolean
    context?: string
    baseUrl: string
    apiKey?: string
  }): Promise<RunOutcome> {
    const userId = randomUUID()
    const userMessage: MessageWithParts = {
      info: { id: userId, sessionID: options.sessionId, role: 'user', time: { created: Date.now() } },
      parts: [{ id: `${userId}-text`, type: 'text', sessionID: options.sessionId, messageID: userId, text: options.prompt }]
    }
    this.store.upsertMessage(options.sessionId, userMessage)
    const sink = options.emitStatus ? this.sink : noopSink
    if (options.emitStatus) {
      sink.onUserMessage(options.sessionId, userMessage)
      sink.onBusy(options.sessionId)
    }
    this.running.set(options.sessionId, options.controller)
    const signal = options.signal ?? options.controller.signal
    const storedHistory = this.store.messages(options.sessionId)
    const { history: cropped, omitted } = cropHistory(storedHistory, this.config.contextChars)
    // Cropping is deliberately lossy, unlike compaction. Make that visible the
    // first time it happens instead of letting the user infer it from a later
    // answer that has quietly forgotten old decisions.
    if (omitted && !storedHistory.some((message) => message.parts.some((part) => part.type === 'compaction' && part.overflow))) {
      const notice = compactionNotice(options.sessionId, { trigger: 'auto', overflow: true })
      this.store.upsertMessage(options.sessionId, notice)
      if (options.emitStatus) sink.onUserMessage(options.sessionId, notice)
    }
    const note = omitted
      ? '\n[Some earlier parts of this thread were omitted to fit the context window. Answer from what remains.]'
      : ''
    const messages = openAiMessagesFromHistory(
      cropped,
      this.systemPrompt(options.cwd, `${options.context ?? ''}${note}`)
    )
    try {
      await this.runAgentLoop(options.sessionId, messages, signal, { mode: options.mode, model: options.model, baseUrl: options.baseUrl, apiKey: options.apiKey, cwd: options.cwd, signal })
      sink.onIdle(options.sessionId)
      return { status: 'completed' }
    } catch (error) {
      const interrupted = signal.aborted
      const message = error instanceof Error ? error.message : String(error)
      sink.onError(options.sessionId, interrupted ? 'The run was interrupted.' : message)
      return { status: interrupted ? 'interrupted' : 'error', error: interrupted ? undefined : message }
    } finally {
      this.running.delete(options.sessionId)
    }
  }

  /** The assistant is a cheap, always-on helper. It routes work and asks for
   *  the user early; the frontier models do the code changes. Its prompt is a
   *  separate role, not a variation on the coding prompt: telling a router to
   *  "always finish with a real edit" is the wrong instruction and pushes it to
   *  do the work itself. */
  private assistantPrompt(cwd: string, context?: string): string {
    return [
      'You are the assistant inside BOSS: a helper that manages threads and tasks.',
      'You route work. You do not write code yourself — you cannot, and that is deliberate.',
      '',
      'Available tools:',
      ...this.tools.map((tool) => `- ${tool.function.name}`),
      '',
      'How to work:',
      '- Read, search, and inspect git freely to understand what is being asked.',
      '- Delegate every code change with spawn_subagent. Pass a stronger model for work that writes code.',
      '- Give a sub-agent a complete, self-contained instruction: it sees only what you write, not this thread.',
      '- Collect results with wait_subagent, then report what changed.',
      '- Use todos to track a task with several parts.',
      '',
      'When to bring in the user:',
      '- Bringing the user in is the default, not the exception. Say what you need and stop.',
      '- Ask before anything hard to reverse, anything outside the current task, or anything you are unsure is wanted.',
      '- If a task is ambiguous, ask rather than guess. A wrong delegation costs more than a question.',
      '- Report a sub-agent failure instead of retrying it a second time.',
      '- A run that ends by asking a good question is a success.',
      '',
      `Current working directory: ${cwd}`,
      context ? `\n${context}` : ''
    ].filter(Boolean).join('\n')
  }

  private systemPrompt(cwd: string, context?: string): string {
    if (this.config.tools === 'assistant') return this.assistantPrompt(cwd, context)
    return [
      'You are an expert coding agent operating inside Lab, a coding agent harness.',
      'Your job is to complete the user\'s task by making real, minimal, working changes to the code.',
      '',
      'Available tools:',
      // Listed from the definitions actually sent, so the prompt cannot claim a
      // tool the model was never given.
      ...this.tools.map((tool) => `- ${tool.function.name}`),
      '',
      'How to work:',
      '- Understand the task first. Reproduce the problem or read the failing test to find the exact cause before editing.',
      '- Search to locate the responsible code, then stop investigating once you know the fix. Do not over-explore.',
      '- Make the smallest edit that solves it. Prefer edit_file for targeted changes and write_file for new/whole files.',
      '- Verify your change: run the relevant test or a minimal repro. If it fails, iterate.',
      '- Do not modify or add test files unless the task is specifically about them.',
      '- Your tool budget is finite — a run that ends without a code change is a failure. Always finish with a real edit.',
      '- When done, stop and give a concise summary of what you changed.',
      '',
      'Guidelines:',
      '- Be concise in your responses',
      '- Show file paths clearly when working with files',
      '',
      `Current working directory: ${cwd}`,
      context ? `\n${context}` : ''
    ].filter(Boolean).join('\n')
  }

  /** The tool-calling loop: stream a turn, run any tool calls the model asks
   *  for, hand the results back, and repeat until the model replies without
   *  tools. */
  private async runAgentLoop(
    sessionId: string,
    messages: LabChatMessage[],
    signal: AbortSignal,
    ctx: TurnContext
  ): Promise<void> {
    let previousSignature: string | undefined
    let repeatStreak = 0
    let toolRounds = 0
    let requestedClosingReply = false
    /** Whether this turn has done anything the user can see: streamed text or
     *  run a tool. Reasoning alone does not count — it is visible, but it is
     *  not work. */
    let producedOutput = false
    let retriedEmptyRound = false
    for (;;) {
      const steers = this.pendingSteers.get(sessionId)
      if (steers?.length) {
        for (const steer of steers) messages.push({ role: 'user', content: steer })
        this.pendingSteers.delete(sessionId)
      }
      const closingReply = toolRounds >= this.config.maxToolIterations
      if (closingReply && !requestedClosingReply) {
        messages.push({
          role: 'user',
          content: '[The tool budget is exhausted. Do not call more tools. Give a concise final response describing what you completed, what remains, and any blockers.]'
        })
        requestedClosingReply = true
      }
      const assistantId = randomUUID()
      let reasoning = ''
      const turn = await streamChatCompletion({
        baseUrl: ctx.baseUrl,
        model: ctx.model,
        messages,
        tools: closingReply ? undefined : this.tools,
        apiKey: ctx.apiKey,
        signal,
        onText: (delta) => {
          this.sink.onTextDelta(sessionId, assistantId, delta)
        },
        onReasoning: (delta) => {
          reasoning += delta
          this.sink.onReasoningDelta(sessionId, assistantId, delta)
        }
      })
      if (process.env.LAB_DEBUG_TOOLCALLS === '1' && (turn.toolCalls.length > 0 || turn.finishReason === 'tool_calls')) {
        process.stderr.write(`[lab-debug] finish=${turn.finishReason ?? ''} calls=${JSON.stringify(turn.toolCalls)}\n`)
      }

      const info: MessageInfo = {
        id: assistantId,
        sessionID: sessionId,
        role: 'assistant',
        model: { id: ctx.model },
        time: { created: Date.now() }
      }
      const parts: Part[] = []
      if (reasoning.trim()) {
        parts.push({
          id: `${assistantId}-reasoning`,
          type: 'reasoning',
          sessionID: sessionId,
          messageID: assistantId,
          text: reasoning,
          ...(turn.reasoningDetails.length > 0
            ? { state: { metadata: { labReasoningDetails: turn.reasoningDetails } } }
            : {})
        })
      }

      // A round with no text and no tool calls is a degenerate completion —
      // usually a gateway dropping the body. Retrying once recovers the
      // transient case; otherwise the turn must end visibly instead of
      // leaving the user staring at a spinner that already stopped meaning
      // anything.
      if (turn.toolCalls.length === 0 && !turn.content.trim()) {
        if (!producedOutput && !retriedEmptyRound) {
          retriedEmptyRound = true
          continue
        }
        if (!producedOutput && !reasoning.trim()) throw new Error('The model returned an empty response.')
        // The turn ended without an answer — either work happened earlier or
        // thinking streamed. Persist what exists plus a closing note, so the
        // transcript shows why the thread went quiet instead of idling in
        // silence.
        parts.push({
          id: `${assistantId}-text`,
          type: 'text',
          sessionID: sessionId,
          messageID: assistantId,
          text: '[The model ended its turn without a reply.]'
        })
        this.store.upsertMessage(sessionId, { info, parts })
        this.sink.onAssistantMessage(sessionId, { info, parts })
        return
      }
      producedOutput = true

      const toolArgs: Record<string, unknown>[] = []
      if (turn.content) parts.push({ id: `${assistantId}-text`, type: 'text', sessionID: sessionId, messageID: assistantId, text: turn.content })
      for (const call of turn.toolCalls) {
        const args = this.safeArgs(call)
        toolArgs.push(args)
        parts.push(toolRunningPart(sessionId, assistantId, call, args))
      }
      if (closingReply && turn.toolCalls.length > 0) {
        parts.push({
          id: `${assistantId}-budget`,
          type: 'text',
          sessionID: sessionId,
          messageID: assistantId,
          text: '[The tool budget was exhausted before the model produced a final reply.]'
        })
      }
      this.store.upsertMessage(sessionId, { info, parts })
      this.sink.onAssistantMessage(sessionId, { info, parts })

      if (turn.toolCalls.length === 0) return
      if (closingReply) {
        for (let index = 0; index < turn.toolCalls.length; index++) {
          const call = turn.toolCalls[index]
          this.reportToolResult(sessionId, assistantId, call.id, {
            status: 'error',
            tool: call.name,
            input: toolArgs[index],
            output: `Tool not run: the ${this.config.maxToolIterations}-round tool budget was exhausted.`
          })
        }
        return
      }
      toolRounds += 1
      messages.push({
        role: 'assistant',
        content: turn.content || null,
        ...(turn.reasoningDetails.length > 0
          ? { reasoning_details: turn.reasoningDetails }
          : turn.reasoning.trim() ? { reasoning_content: turn.reasoning } : {}),
        tool_calls: turn.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments }
        }))
      })
      // A degenerate tool call with no name is a parsing or model-side miss, not
      // a loop — never count it toward the repeat guard. The hard iteration cap
      // still bounds the damage.
      const hasRealCall = turn.toolCalls.some((call, index) => {
        const inferred = call.name || inferToolName(toolArgs[index] ?? {}) || ''
        return inferred.trim().length > 0
      })
      const signature = turn.toolCalls.map((call) => `${call.name}(${call.arguments})`).join('|')
      if (hasRealCall) {
        if (signature === previousSignature) {
          repeatStreak += 1
          // A model that repeats one call forever is stuck, but repeating a call
          // once is ordinary — re-reading a file right after editing it is the
          // common case. Only a third identical call in a row is a real loop.
          if (repeatStreak >= 2) {
            throw new Error(`The model repeated the same tool call ${turn.toolCalls[0].name} ${repeatStreak + 1} times in a row; stopping.`)
          }
        } else {
          repeatStreak = 0
        }
        previousSignature = signature
      }
      for (let index = 0; index < turn.toolCalls.length; index++) {
        const call = turn.toolCalls[index]
        const output = await this.executeTool(sessionId, assistantId, call, toolArgs[index], signal, ctx)
        messages.push({ role: 'tool', tool_call_id: call.id, content: output })
      }
    }
  }

  private safeArgs(call: LabFunctionCall): Record<string, unknown> {
    try {
      return parseToolArguments(call.arguments)
    } catch (error) {
      return { _parseError: error instanceof Error ? error.message : String(error), _raw: call.arguments }
    }
  }

  /** Coerce the model's todos payload into stable Todo records. Keeps an id if
   *  one is given so the user's list does not churn between calls. */
  private normalizeTodos(raw: unknown): Todo[] {
    if (!Array.isArray(raw)) return []
    return raw.flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const content = String((item as { content?: unknown }).content ?? '').trim()
      if (!content) return []
      const status = (item as { status?: unknown }).status
      const validStatus = status === 'pending' || status === 'in_progress' || status === 'completed' || status === 'cancelled'
      return [{
        id: typeof (item as { id?: unknown }).id === 'string' ? (item as { id: string }).id : randomUUID(),
        content,
        status: validStatus ? status as Todo['status'] : 'pending',
        sessionID: undefined
      }]
    })
  }

  /** Gate one tool call, then run it and publish the result. Reads always run;
   *  writes and shell follow the mode, then any stored always-grant, then the
   *  injected gate. */
  private async executeTool(
    sessionId: string,
    assistantId: string,
    call: LabFunctionCall,
    args: Record<string, unknown>,
    signal: AbortSignal,
    ctx: TurnContext
  ): Promise<string> {
    // Some providers stream tool calls with an empty name but valid arguments;
    // recover the tool from the argument shape so the call still runs.
    const name = call.name || inferToolName(args) || ''
    const effectiveCall = name ? { ...call, name } : call
    const decision = await this.gateDecision(sessionId, effectiveCall, args, signal, ctx.mode)
    if (signal.aborted) return 'The run was interrupted.'
    if (decision === 'deny') {
      const output = `Permission denied: the user declined ${name || call.name}. Adjust your plan or ask again.`
      this.reportToolResult(sessionId, assistantId, call.id, { status: 'error', tool: name || call.name, input: args, output })
      return output
    }
    if (isOrchestrationTool(name)) {
      const output = await this.orchestrator.execute(sessionId, name, args, { model: ctx.model, cwd: ctx.cwd, parentSignal: ctx.signal })
      this.reportToolResult(sessionId, assistantId, call.id, { status: 'completed', tool: name, input: args, output })
      return output
    }
    const external = this.externalTools
    if (external && external.definitions().some((tool) => tool.function.name === name)) {
      try {
        const output = await external.execute(name, args, sessionId)
        this.reportToolResult(sessionId, assistantId, call.id, { status: 'completed', tool: name, input: args, output })
        return output
      } catch (error) {
        const output = error instanceof Error ? error.message : String(error)
        this.reportToolResult(sessionId, assistantId, call.id, { status: 'error', tool: name, input: args, output })
        return output
      }
    }
    if (name === 'todos') {
      const todos = this.normalizeTodos(args.todos)
      this.store.setTodos(sessionId, todos)
      this.sink.onTodos(sessionId, todos)
      const output = JSON.stringify(todos)
      this.reportToolResult(sessionId, assistantId, call.id, { status: 'completed', tool: name, input: args, output })
      return output
    }
    try {
      const result = await runTool(name, args, { cwd: ctx.cwd, snapshots: this.snapshots })
      const output = result.truncated && result.output ? `${result.output}\n[output truncated]` : result.output
      this.reportToolResult(sessionId, assistantId, call.id, { status: 'completed', tool: name, input: args, output })
      return output
    } catch (error) {
      const output = error instanceof Error ? error.message : String(error)
      this.reportToolResult(sessionId, assistantId, call.id, { status: 'error', tool: name, input: args, output })
      return output
    }
  }

  private reportToolResult(sessionId: string, assistantId: string, callId: string, state: { status: 'completed' | 'error'; tool?: string; input?: unknown; output: string }): void {
    const part: Part = { id: callId, type: 'tool', sessionID: sessionId, messageID: assistantId, state }
    this.store.updatePart(sessionId, assistantId, part)
    this.sink.onToolPart(sessionId, part)
  }

  /** Mode → gate decision. Plan denies, auto accepts, accept-edits accepts file
   *  edits, and ask falls through to stored grants, then to the injected gate
   *  which prompts the user. Reads always run. */
  private async gateDecision(
    sessionId: string,
    call: LabFunctionCall,
    args: Record<string, unknown>,
    signal: AbortSignal,
    mode: BackendModeId
  ): Promise<'allow' | 'deny'> {
    const level = permissionForTool(call.name)
    const activeMode = this.modes.get(sessionId) ?? mode
    const decision = resolveToolGate(activeMode, level)
    if (decision === 'allow') return 'allow'
    if (decision === 'deny') return 'deny'
    if (alwaysGrantsAllow(this.store.get(sessionId).alwaysAllow, call.name)) return 'allow'
    return this.gate.request(sessionId, call, args, signal)
  }
}
