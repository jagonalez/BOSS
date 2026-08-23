import { app, BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Backend } from './backend'
import { threadContextPrompt } from './thread-context'
import type {
  BackendDescriptor,
  BackendId,
  BackendRequest,
  BackendCapabilities,
  BackendMessageOptions,
  BackendModeId,
  BackendModelPreference,
  LabConnectionsSettings,
  LabConnectionUpdate,
  DelegatePlacement,
  QueuedFollowUp,
  QueuedFollowUpAttachment,
  ThreadCreationScope,
  ThreadTitleSettings
} from '@shared/backend'
import { isAbortError, withBackendDefaults, THREAD_BUSY_ERROR } from '@shared/backend'
import { DEFAULT_THREAD_TITLE_SETTINGS, titleFromFirstPrompt } from '@shared/thread-title'
import { DEFAULT_SANDBOX_SETTINGS } from '@shared/sandbox'
import type { SandboxSettings } from '@shared/sandbox'
import type { EventMessage, FileDiff, MessageWithParts, Part, SessionInfo } from '@shared/opencode'
import { isCompletedTodoToolCall } from '@shared/opencode'
import type { ThreadBus } from '../thread-bus'
import type { ThreadBusConnection, ThreadBusSnapshot, ThreadBusThread } from '@shared/thread-bus'
import { projectScope, type ProjectScope } from '../project-identity'
import { envHint, resolveBackendBin, type BinaryOverrides } from '../backend-bin'
import type { WorktreeInfo, WorktreeSettings } from '@shared/worktree'
import type { WorktreeManager } from '../worktree-manager'
import type { BackendAuth } from '../backend-auth'
import type { TranscriptStore } from '../transcript-store'
import type { ImageStore } from '../image-store'
import type { NotificationRouter } from '../notification-router'
import { toolResultImage, type AgentToolImage } from '@shared/qa'
import type { AttentionKind, SupervisionSnapshot, ThreadAttention, ThreadResult, ThreadUsageTotals, TranscriptSearchResult } from '@shared/supervision'
import { extractSummary, lastAssistantText } from '@shared/thread-result'
import { fanOutTitle, fanOutViolation, type FanOutWorker } from '@shared/fan-out'
import {
  budgetViolation,
  EMPTY_TASK_POLICY_STATE,
  fallbackApplies,
  normalizeTaskPolicy,
  parseReviewVerdict,
  type RunOutcome,
  type TaskPolicy,
  type TaskPolicyState
} from '@shared/task-policy'
import { hostPermissionResponse, resolveThreadMode } from '@shared/permission-mode'
import { backendVersionWarning } from '@shared/backend-version'

interface ThreadBinding {
  id: string
  backendId: BackendId
  nativeSessionId: string
  nativeSessionOwnership: 'boss' | 'imported'
  projectId: string
  projectPath: string
  executionPath: string
  title?: string
  createdAt: number
  updatedAt: number
  parentID?: string
  lineage?: SessionInfo['lineage']
  worktree?: WorktreeInfo
  followUps?: QueuedFollowUp[]
  /** The assistant message an image part should attach itself to.
   *
   *  An image emitted as a part of its own still has to belong to a message,
   *  and inventing an id for it puts it in a message that nothing else shares.
   *  groupTurns only closes a turn on a user message, so such an orphan stays
   *  in the open turn and is drawn again under every later reply until the
   *  user speaks. Holding the last assistant message the backend reported
   *  gives the image the same home as the tool that produced it.
   *
   *  Deliberately not persisted: it is only meaningful while a run is live,
   *  and a reload rebuilds the transcript from the recorded parts anyway. */
  lastAssistantMessageId?: string
  attention?: ThreadAttention
  /**
   * Hidden from the default thread list.
   *
   * This used to live in the renderer's localStorage, which meant only the
   * window that archived a thread knew about it: the phone and the mobile page
   * both showed every thread ever created, and the counts disagreed. Archiving
   * is a property of the thread, so it belongs here where every client sees it.
   */
  archived?: boolean
  policy?: TaskPolicy
  /** What the policy has already done for this thread. Separate from the
   *  policy itself so editing the configuration never rewrites history. */
  policyState?: TaskPolicyState
  /** What this thread's last finished run produced. */
  result?: ThreadResult
  /** The thread's permission mode, and the only copy that decides anything.
   *
   *  A backend that takes its mode as a launch argument reads it once, so a
   *  mid-run change can never reach the running process. Keeping the mode here
   *  lets the permission handler read what the mode is *now* rather than what
   *  it was at spawn. */
  mode?: BackendModeId
  /** The model this thread last ran on, for the same reason the mode is here.
   *
   *  An agent-created thread resolves its model in main and never passes
   *  through renderer state, so without this the renderer had nothing to show
   *  and fell back to the global model — a toolbar that disagreed with the
   *  model the thread was actually running on. */
  model?: { providerID: string; modelID: string; variant?: string }
}

/** The stored form of a thread's model, from a preference or a sent message.
 *
 *  Both carry the same three fields, and dropping an absent variant keeps a
 *  binding that never chose one out of the persisted state. */
function boundModel(
  source: { providerID: string; modelID: string; variant?: string } | undefined
): ThreadBinding['model'] {
  if (!source) return undefined
  return {
    providerID: source.providerID,
    modelID: source.modelID,
    ...(source.variant ? { variant: source.variant } : {})
  }
}

type LegacyThreadBinding = Omit<ThreadBinding, 'nativeSessionOwnership' | 'projectId' | 'executionPath'>

interface LegacyBackendState {
  version: 1
  threads: LegacyThreadBinding[]
}

interface PreviousBackendState {
  version: 2
  legacyOpenCodeImportComplete: boolean
  threads: ThreadBinding[]
}

interface StoredBackendState {
  version: 3
  threads: ThreadBinding[]
  threadTitleSettings?: ThreadTitleSettings
  sandboxSettings?: SandboxSettings
}

interface BackendDefinition {
  label: string
  description: string
  command?: string
  capabilities: BackendCapabilities
  modes: BackendDescriptor['modes']
}

const DEFINITIONS: Record<BackendId, BackendDefinition> = {
  opencode: {
    label: 'OpenCode',
    description: 'OpenCode server with native sessions, permissions, tools, and providers.',
    capabilities: { streaming: true, models: true, permissions: true, nativeFork: true, steering: 'stop-and-redirect', branching: 'message', images: true, mcp: true, interactiveQuestions: true, nativeAutoMode: false },
    modes: [
      { id: 'ask', label: 'Ask', description: 'prompt before sensitive actions' },
      { id: 'auto', label: 'Auto', description: 'approve supported actions automatically' },
      { id: 'plan', label: 'Plan', description: 'read-only planning agent' }
    ]
  },
  pi: {
    label: 'Pi',
    description: 'Pi coding agent over its native JSONL RPC protocol.',
    command: 'pi',
    capabilities: { streaming: true, models: true, permissions: false, nativeFork: true, steering: 'native', branching: 'message', images: true, mcp: false, interactiveQuestions: false, nativeAutoMode: true },
    modes: [{ id: 'auto', label: 'Approved', description: 'Pi RPC runs with its approved tool policy' }]
  },
  codex: {
    label: 'Codex',
    description: 'Codex CLI through the supported app-server JSON-RPC protocol.',
    command: 'codex',
    capabilities: { streaming: true, models: true, permissions: true, nativeFork: true, steering: 'native', branching: 'thread', images: true, mcp: false, interactiveQuestions: false, nativeAutoMode: true },
    modes: [
      { id: 'ask', label: 'Ask', description: 'request approval when Codex needs to leave its sandbox' },
      { id: 'auto', label: 'Auto', description: 'run inside the workspace sandbox without approval prompts' },
      { id: 'plan', label: 'Plan', description: 'read-only filesystem sandbox' }
    ]
  },
  claude: {
    label: 'Claude Code',
    description: 'Claude Code through its streaming non-interactive protocol.',
    command: 'claude',
    capabilities: { streaming: true, models: true, permissions: true, nativeFork: false, steering: 'stop-and-redirect', branching: 'context-copy', images: true, mcp: false, interactiveQuestions: false, nativeAutoMode: true },
    modes: [
      { id: 'ask', label: 'Ask', description: 'prompt before tools that need approval' },
      { id: 'auto', label: 'Auto', description: 'let Claude decide which tool calls can run automatically' },
      { id: 'accept-edits', label: 'Edit automatically', description: 'approve file edits; prompt for other protected tools' },
      { id: 'plan', label: 'Plan', description: 'read-only planning mode' }
    ]
  },
  lab: {
    label: 'Lab',
    description: 'From-scratch harness speaking OpenAI-compatible APIs to a local ollama or any cloud endpoint.',
    // No command: there is no CLI to resolve, so the backend is always
    // available regardless of PATH (mirrors how opencode has no command).
    capabilities: { streaming: true, models: true, permissions: true, nativeFork: false, steering: 'stop-and-redirect', branching: 'thread', images: false, mcp: false, interactiveQuestions: false, nativeAutoMode: true },
    modes: [
      { id: 'ask', label: 'Ask', description: 'prompt before every file write or shell command' },
      { id: 'auto', label: 'Auto', description: 'run file writes and shell commands without asking' },
      { id: 'accept-edits', label: 'Edit automatically', description: 'approve file edits; prompt for shell commands' },
      { id: 'plan', label: 'Plan', description: 'read-only; no writes or shell' }
    ]
  }
}

function stateFile(): string {
  return join(app.getPath('userData'), 'backend-threads.json')
}

function now(): number {
  return Date.now()
}

function probeVersion(command: string): { available: boolean; version?: string; reason?: string } {
  const bin = resolveBackendBin(command)
  try {
    const output = execFileSync(bin, ['--version'], {
      encoding: 'utf8',
      timeout: 2500,
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
    return { available: true, version: output.split('\n')[0] }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return {
      available: false,
      reason:
        code === 'ENOENT'
          ? `${command} is not installed or is not on PATH. Set its location in Settings > Models & connections, or ${envHint(command)}.`
          : `${command} could not be started.`
    }
  }
}

function textFromParts(parts: unknown[]): string {
  return parts
    .map((part) => {
      if (!part || typeof part !== 'object') return ''
      const item = part as { type?: string; text?: string; filename?: string; mime?: string }
      if (item.type === 'text') return item.text ?? ''
      if (item.type === 'file') return `[Attached file: ${item.filename ?? item.mime ?? 'file'}]`
      return item.text ?? ''
    })
    .filter(Boolean)
    .join('\n')
}

function transcript(messages: MessageWithParts[], maxChars = 48_000): string {
  const rendered = messages.slice(-30).map((message) => {
    const body = message.parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .filter(Boolean)
      .join('\n')
    return `${message.info.role === 'user' ? 'USER' : 'ASSISTANT'}:\n${body}`
  }).filter((item) => !item.endsWith(':\n'))
  let result = rendered.join('\n\n')
  if (result.length > maxChars) result = `[…earlier context omitted…]\n\n${result.slice(-maxChars)}`
  return result
}

export class BackendManager {
  private projectPath = ''
  private readonly bindings = new Map<string, ThreadBinding>()
  private readonly started = new Set<BackendId>()
  private readonly starting = new Map<BackendId, Promise<Backend>>()
  private readonly unsubscribers = new Map<BackendId, () => void>()
  private readonly busyThreads = new Set<string>()
  private readonly followUpDeliveries = new Set<string>()
  /** Threads BOSS just stopped on purpose, so the abort a backend reports for
   *  that stop is not shown as a failed turn. Cleared by the next run. */
  private readonly intentionalAborts = new Set<string>()
  /** Threads whose stored transcript is ahead of the backend's native history.
   *
   *  Set when a send failed after BOSS had already recorded the message: the
   *  backend never saw it, so its history must not be treated as the complete
   *  truth. Cleared as soon as a run starts, because from then on the backend
   *  is authoritative again. */
  private readonly pruneSuspended = new Set<string>()
  private threadBus?: ThreadBus
  private images?: ImageStore
  private notifications?: NotificationRouter
  private readonly eventCbs = new Set<(event: Record<string, unknown>) => void>()
  private automations?: { handle(request: BackendRequest): Promise<unknown> }
  private mcpHub?: { handle(request: BackendRequest): Promise<unknown> }
  private mobile?: { handle(request: BackendRequest): Promise<unknown> }
  private remote?: { handle(request: BackendRequest): Promise<unknown> }
  private telegram?: { handle(request: BackendRequest): Promise<unknown> }
  private binaryOverrides?: BinaryOverrides
  private defaultModels?: Partial<Record<BackendId, BackendModelPreference>>
  private threadTitleSettings: ThreadTitleSettings = { ...DEFAULT_THREAD_TITLE_SETTINGS }
  private sandboxSettings: SandboxSettings = { ...DEFAULT_SANDBOX_SETTINGS }
  private loaded = false
  private worktreeCleanupTimer?: NodeJS.Timeout

  constructor(
    private readonly backends: Record<BackendId, Backend>,
    private readonly worktrees?: WorktreeManager,
    private readonly backendAuth?: BackendAuth,
    private readonly transcripts?: TranscriptStore
  ) {}

  attachImageStore(images: ImageStore): void {
    this.images = images
  }

  attachNotifications(router: NotificationRouter): void {
    this.notifications = router
  }

  /** Put an image a tool returned into the thread's transcript.
   *
   *  Called for every agent tool that answers with one — a QA screenshot, an
   *  MCP server's chart — so the user sees what the agent saw rather than
   *  taking its word for it. The bytes go to disk and the part carries a URL,
   *  since a transcript is read in full every time its thread is opened. */
  publishToolImage(threadId: string, tool: string, image: AgentToolImage): void {
    const binding = this.bindings.get(threadId)
    if (!binding || !this.images) return
    const stored = this.images.write(threadId, image.mimeType, image.data)
    if (!stored) return
    this.emitImagePart(binding, tool, stored)
  }

  /** Move images out of a tool result and into parts of their own.
   *
   *  Claude reports a tool_result whose content can hold an image block, and
   *  state.output is handed to the renderer verbatim — which stringified the
   *  block and printed base64 where a picture belonged. The bytes go to the
   *  store, an image part is emitted beside the tool call, and the output the
   *  tool part keeps is the same content with the image block replaced by a
   *  short note. Returns the part unchanged when there is nothing to move, so
   *  the ordinary case costs one type check. */
  private extractToolResultImages(binding: ThreadBinding, part: MessageWithParts['parts'][number]): MessageWithParts['parts'][number] {
    if (part.type !== 'tool' || !this.images) return part
    const output = part.state?.output
    if (!Array.isArray(output)) return part
    const tool = typeof part.state?.tool === 'string' ? part.state.tool : 'tool'
    let changed = false
    const rewritten = output.map((block) => {
      const image = toolResultImage(block)
      if (!image) return block
      const stored = this.images?.write(binding.id, image.mimeType, image.data)
      if (!stored) {
        // A format the store will not take, or a disk that refused it. Say so
        // rather than leaving the base64 to be printed as text.
        changed = true
        return { type: 'text', text: `[Image omitted: ${image.mimeType} could not be displayed.]` }
      }
      changed = true
      // The image came out of this tool part, so it belongs to the same
      // message — no need to fall back to whichever assistant message is
      // current.
      this.emitImagePart(binding, tool, stored, typeof part.messageID === 'string' ? part.messageID : undefined)
      return { type: 'text', text: `[Image shown above: ${stored.mime}]` }
    })
    if (!changed) return part
    return { ...part, state: { ...part.state, output: rewritten } }
  }

  /** Record and announce one stored image as a part of its own. */
  private emitImagePart(binding: ThreadBinding, tool: string, stored: { url: string; mime: string }, messageId?: string): void {
    // The message the image belongs to: the tool part's own when the image was
    // lifted out of a tool result, otherwise the assistant message currently
    // being written. A fresh id is the last resort rather than the default —
    // it produces a message no other part shares, and since a turn is only
    // closed by a user message, that orphan trails the open turn and is drawn
    // again under every later reply until the user speaks.
    const owner = messageId ?? binding.lastAssistantMessageId ?? `assistant-tool-image-${randomUUID()}`
    // Named after the image it shows, not the moment it was emitted. The
    // renderer replaces a part with the same id in the same message and appends
    // anything else, so a random id made a re-reported image a second picture
    // rather than the same one. The stored url is already unique per written
    // image, which makes it the identity: emit the same image twice and the
    // reader sees it once, while two different images stay two.
    const part: Part = {
      id: `tool-image-${stored.url}`,
      type: 'file',
      sessionID: binding.id,
      messageID: owner,
      state: { status: 'completed', name: tool, mime: stored.mime, url: stored.url }
    }
    this.transcripts?.recordPart(this.transcriptSource(binding), part)
    this.emit({
      type: 'message.part.updated',
      properties: { part },
      backendId: binding.backendId
    })
  }

  attachThreadBus(threadBus: ThreadBus): void {
    this.threadBus = threadBus
    for (const backend of Object.values(this.backends)) {
      backend.setThreadBusHandler?.((call) => threadBus.agentCall(backend.id, call.nativeThreadId, call.tool, call.arguments))
    }
  }

  configureThreadBus(connection: ThreadBusConnection): void {
    for (const backend of Object.values(this.backends)) backend.configureThreadBus?.(connection)
  }

  get currentProject(): string {
    return this.projectPath
  }

  private get currentScope(): ProjectScope {
    return projectScope(this.projectPath)
  }

  private get globalScope(): ProjectScope {
    const executionPath = join(app.getPath('userData'), 'chats')
    mkdirSync(executionPath, { recursive: true })
    return { projectId: 'global', projectPath: '', executionPath }
  }

  onEvent(callback: (event: Record<string, unknown>) => void): () => void {
    this.eventCbs.add(callback)
    return () => {
      this.eventCbs.delete(callback)
    }
  }

  emit(event: Record<string, unknown>): void {
    for (const callback of this.eventCbs) callback(event)
  }

  private errorDetail(value: unknown): string | undefined {
    if (value instanceof Error) return value.message.slice(0, 240)
    if (typeof value === 'string') return value.slice(0, 240)
    if (value && typeof value === 'object') {
      const record = value as { message?: unknown; data?: { message?: unknown } }
      const message = record.message ?? record.data?.message
      if (typeof message === 'string') return message.slice(0, 240)
    }
    return undefined
  }

  private setThreadAttention(binding: ThreadBinding, kind: AttentionKind, detail?: string): void {
    if (kind === 'completed' && BrowserWindow.getAllWindows().some((window) => window.isFocused())) return
    const changed = binding.attention?.kind !== kind || binding.attention?.detail !== detail
    binding.attention = { kind, detail, createdAt: now() }
    this.save()
    // Only a repeat is dropped here. Whether a focused BOSS should suppress a
    // notification is the router's call, and it applies that to the desktop
    // alone: a webhook exists to reach someone away from this machine, and a
    // focused window says nothing about where they are.
    if (!changed) return
    const body = detail ?? ({
      permission: 'Waiting for permission.',
      question: 'Waiting for an answer.',
      completed: 'Finished working.',
      error: 'The run failed.',
      interrupted: 'The run was interrupted.'
    } satisfies Record<AttentionKind, string>)[kind]
    // Through the router rather than straight to the desktop: a thread that
    // needs permission is exactly what someone away from the machine wants to
    // hear about, and only the router knows about the other channels.
    this.notifications?.publish({
      type: kind === 'error' || kind === 'interrupted'
        ? 'task.failed'
        : kind === 'completed' ? 'task.completed' : 'task.needs_attention',
      title: binding.title ?? 'BOSS task',
      body,
      threadId: binding.id,
      projectPath: binding.projectPath,
      createdAt: now()
    })
  }

  private clearThreadAttention(binding: ThreadBinding): void {
    if (!binding.attention) return
    binding.attention = undefined
    this.save()
  }

  /** Start the next reviewer, or the fallback, for a thread whose run ended.
   *
   *  Reviewers and fallback need the same three things: the moment a run ends,
   *  how it ended, and permission to start another thread. Both therefore hang
   *  off this one trigger rather than growing separate ones.
   *
   *  A run the user stopped on purpose never arrives here. That stop is not a
   *  failure, so falling back from it would restart work the user just ended. */
  /** Record what the run produced, then let the policy act on it.
   *
   *  The result is captured first so a reviewer that reads the thread sees the
   *  same summary and file count the user does. */
  private async captureResult(binding: ThreadBinding, outcome: RunOutcome): Promise<void> {
    const backend = await this.ensureStarted(binding.backendId)
    const [messages, diffs] = await Promise.all([
      backend.messagesList(binding.nativeSessionId).catch(() => [] as MessageWithParts[]),
      backend.diffGet(binding.nativeSessionId).catch(() => [] as FileDiff[])
    ])
    binding.result = {
      summary: extractSummary(messages),
      changedFiles: Array.isArray(diffs) ? diffs.length : 0,
      branch: binding.worktree?.branch,
      finishedAt: now(),
      status: outcome
    }
    this.save()
    this.emit({
      type: 'thread.result',
      properties: { threadId: binding.id, result: binding.result },
      backendId: binding.backendId
    })
  }

  private async runPolicy(binding: ThreadBinding, outcome: RunOutcome): Promise<void> {
    // A reviewer finishing is a reviewer verdict, not a new task to review.
    // This is checked before the policy, because a reviewer thread carries no
    // policy of its own — the one it serves belongs to the thread that spawned
    // it. Checking the policy first would make every verdict unreachable.
    if (binding.lineage?.kind === 'review' || binding.lineage?.kind === 'fallback') {
      await this.recordReviewerOutcome(binding)
      return
    }
    const policy = binding.policy
    if (!policy) return
    if (fallbackApplies(policy, outcome)) {
      await this.startFallback(binding, policy.fallback!, outcome)
      return
    }
    if (outcome !== 'completed') return
    // Nothing changed, so there is nothing to review. A thread can finish a run
    // having only talked — asked a question, reported a blocker — and starting
    // a reviewer on an empty diff spends a run to be told the work was never
    // done. Say that directly instead.
    if (!binding.result?.changedFiles && policy.reviewers.length) {
      this.setThreadAttention(binding, 'completed', 'Finished without changing any files, so no reviewer ran.')
      return
    }
    await this.startNextReviewer(binding, policy)
  }

  private policyStateOf(binding: ThreadBinding): TaskPolicyState {
    if (!binding.policyState) binding.policyState = { ...EMPTY_TASK_POLICY_STATE, reviewers: [] }
    return binding.policyState
  }

  private async startNextReviewer(binding: ThreadBinding, policy: TaskPolicy): Promise<void> {
    const state = this.policyStateOf(binding)
    const reviewer = policy.reviewers[state.cursor]
    if (!reviewer) return
    // Claim the slot before the await. Two completion events for one run would
    // otherwise start the same reviewer twice.
    state.cursor += 1
    this.save()

    const instruction = [
      'You are a reviewer. Review the work described below against the goal.',
      policy.goal ? `Goal: ${policy.goal}` : '',
      reviewer.instruction ? `Review instructions: ${reviewer.instruction}` : '',
      'Inspect the diff and any tests or checks you need.',
      'Finish your reply with a single line reading exactly PASS or CHANGES_REQUESTED.',
      'When requesting changes, follow that line with one "- " bullet per issue.'
    ].filter(Boolean).join('\n')

    const created = await this.delegateForPolicy(binding, reviewer.backendId, instruction, 'review')
    state.reviewers.push({
      backendId: reviewer.backendId,
      threadId: created.id,
      startedAt: now()
    })
    this.save()
    this.emit({
      type: 'thread.policy.reviewer.started',
      properties: { threadId: binding.id, reviewerThreadId: created.id, backendId: reviewer.backendId },
      backendId: binding.backendId
    })
  }

  private async startFallback(
    binding: ThreadBinding,
    fallback: NonNullable<TaskPolicy['fallback']>,
    outcome: RunOutcome
  ): Promise<void> {
    const state = this.policyStateOf(binding)
    // One fallback per thread. A backend that fails repeatedly must not spawn a
    // new thread for every failure.
    if (state.fallbackThreadId) return
    state.fallbackThreadId = 'pending'
    this.save()

    const instruction = [
      `The previous attempt on this task ended (${outcome}). Continue it on a different backend.`,
      binding.policy?.goal ? `Goal: ${binding.policy.goal}` : '',
      'Review what the previous attempt did before repeating any of it.'
    ].filter(Boolean).join('\n')

    try {
      const created = await this.delegateForPolicy(binding, fallback.backendId, instruction, 'fallback')
      state.fallbackThreadId = created.id
      state.fallbackAt = now()
      this.save()
      this.emit({
        type: 'thread.policy.fallback.started',
        properties: { threadId: binding.id, fallbackThreadId: created.id, backendId: fallback.backendId },
        backendId: binding.backendId
      })
    } catch (error) {
      // Release the claim so a later failure can still fall back.
      state.fallbackThreadId = undefined
      this.save()
      throw error
    }
  }

  /** Record a finished reviewer's verdict, then continue the chain.
   *
   *  A pass moves to the next reviewer. Requested changes stop the chain and
   *  leave the result for the user, who decides what to do about it. */
  private async recordReviewerOutcome(binding: ThreadBinding): Promise<void> {
    const ownerId = binding.lineage?.sourceThreadId
    if (!ownerId) return
    const owner = this.bindings.get(ownerId)
    if (!owner?.policyState) return
    const record = owner.policyState.reviewers.find((entry) => entry.threadId === binding.id)
    if (!record || record.verdict) return

    const backend = await this.ensureStarted(binding.backendId)
    const messages = await backend.messagesList(binding.nativeSessionId).catch(() => [])
    const parsed = parseReviewVerdict(lastAssistantText(messages))
    record.finishedAt = now()
    record.verdict = parsed?.verdict
    record.notes = parsed?.notes
    this.save()
    this.emit({
      type: 'thread.policy.reviewer.finished',
      properties: { threadId: ownerId, reviewerThreadId: binding.id, verdict: record.verdict ?? null },
      backendId: owner.backendId
    })
    // A verdict is the answer the user was waiting on, so it goes out on every
    // channel rather than only appearing in the thread they would have to open.
    this.notifications?.publish({
      type: 'review.completed',
      title: owner.title ?? 'BOSS task',
      body: record.verdict === 'pass'
        ? 'A reviewer passed the work.'
        : record.verdict === 'changes-requested'
          ? `A reviewer requested changes${record.notes?.length ? `: ${record.notes[0]}` : '.'}`
          : 'A reviewer finished without a verdict.',
      threadId: ownerId,
      projectPath: owner.projectPath,
      createdAt: now()
    })
    // Only a clear pass advances. No verdict means the reviewer did not follow
    // the contract, and treating that as a pass would approve unreviewed work.
    if (record.verdict !== 'pass') {
      this.setThreadAttention(owner, 'completed', record.verdict === 'changes-requested'
        ? 'A reviewer requested changes.'
        : 'A reviewer finished without a verdict.')
      return
    }
    if (owner.policy) await this.startNextReviewer(owner, owner.policy)
  }

  /** Spawn a policy-owned worker beside the thread it serves.
   *
   *  Reviewers run in the same checkout as the work they review; a worktree of
   *  their own would show them a tree without that work in it. */
  private async delegateForPolicy(
    binding: ThreadBinding,
    backendId: BackendId,
    instruction: string,
    kind: 'review' | 'fallback'
  ): Promise<SessionInfo> {
    const packet = await this.contextPacket(binding.id, instruction)
    const label = kind === 'review' ? 'Review' : 'Fallback'
    const created = await this.sessionCreateInScope(
      backendId,
      {
        projectId: binding.projectId,
        projectPath: binding.projectPath,
        executionPath: binding.executionPath
      },
      `${label} · ${binding.title ?? 'Untitled'}`.slice(0, 72),
      { kind, sourceThreadId: binding.id, sourceBackendId: binding.backendId },
      binding.worktree
    )
    const mode = kind === 'review'
      ? DEFINITIONS[backendId].modes.find((entry) => entry.id === 'ask')?.id
        ?? DEFINITIONS[backendId].modes.find((entry) => entry.id === 'plan')?.id
        ?? DEFINITIONS[backendId].modes[0]?.id
      : DEFINITIONS[backendId].modes.find((entry) => entry.id === 'auto')?.id
        ?? DEFINITIONS[backendId].modes[0]?.id
    await this.sendMessage(
      created.id,
      [{ type: 'text', text: packet }],
      withBackendDefaults(this.defaultModel(backendId), undefined, mode)
    )
    return created
  }

  /** Hand a settled run to the policy, without letting it break the caller.
   *
   *  This runs inside the backend event handler. A policy that cannot start a
   *  reviewer must not stop that handler from reporting the run itself, so the
   *  failure is reported as its own event and goes no further. */
  private settleRun(binding: ThreadBinding, outcome: RunOutcome): void {
    // Capture first, so a reviewer reads the same result the user sees, and so
    // every finished thread records one — including reviewers, which return
    // early from the policy step below.
    void this.captureResult(binding, outcome)
      .then(() => this.runPolicy(binding, outcome))
      .catch((error) => {
      this.emit({
        type: 'thread.policy.failed',
        properties: {
          threadId: binding.id,
          message: this.errorDetail(error) ?? 'The task policy could not run.'
        },
        backendId: binding.backendId
      })
    })
  }

  /** The mode this thread is in right now.
   *
   *  Falls back to the backend's first mode so a thread created before the mode
   *  was stored here still answers with something its backend offers. */
  private modeFor(binding: ThreadBinding): BackendModeId {
    return resolveThreadMode(binding.mode, DEFINITIONS[binding.backendId].modes.map((mode) => mode.id))
  }

  /** Record the thread's mode and tell the running agent about it.
   *
   *  This is the write half of the single source of truth. The renderer calls
   *  it the moment the user picks a mode, so a change lands even mid-run.
   *
   *  A backend with its own Auto policy has to be told, because BOSS does not
   *  answer its requests for it. claude accepts the change on its control
   *  channel and applies it immediately; codex takes its policy per turn, so
   *  the change waits for the next one. That difference is reported rather
   *  than hidden: `pendingUntilNextMessage` says the switch has not taken
   *  effect yet. */
  async setThreadMode(threadId: string, mode: BackendModeId): Promise<SessionInfo & { pendingUntilNextMessage?: boolean }> {
    const binding = this.binding(threadId)
    const changed = binding.mode !== mode
    if (changed) {
      binding.mode = mode
      binding.updatedAt = now()
      this.save()
    }
    // Only while the thread is actually running. An idle thread picks the mode
    // up from its next sendMessage, so there is nothing to tell and nothing
    // pending.
    let pendingUntilNextMessage = false
    if (this.busyThreads.has(threadId)) {
      const backend = this.backends[binding.backendId]
      const applied = backend.permissionModeSet
        ? await backend.permissionModeSet(binding.nativeSessionId, mode).catch(() => false)
        : true
      pendingUntilNextMessage = !applied
    }
    const session = this.session(binding)
    this.emit({ type: 'session.updated', properties: { info: session }, backendId: binding.backendId })
    return pendingUntilNextMessage ? { ...session, pendingUntilNextMessage } : session
  }

  /** What BOSS itself should do with a permission request, given the mode now.
   *
   *  Read when the request arrives, never captured, so a mid-run change applies
   *  to the very next request. Returning undefined means "ask the user".
   *
   *  Backends with their own Auto policy are told about the change instead
   *  (see setThreadMode) and keep deciding for themselves, so what they send is
   *  an escalation and reaches the user. */
  private hostPermissionResponse(binding: ThreadBinding): 'once' | 'reject' | undefined {
    return hostPermissionResponse(
      this.modeFor(binding),
      DEFINITIONS[binding.backendId].capabilities.nativeAutoMode
    )
  }

  scopeFor(projectPath: string): ProjectScope {
    return projectPath ? projectScope(projectPath) : this.globalScope
  }

  private defaultModelsFile(): string {
    return join(app.getPath('userData'), 'backend-defaults.json')
  }

  private loadDefaultModels(): void {
    if (this.defaultModels) return
    try {
      this.defaultModels = JSON.parse(readFileSync(this.defaultModelsFile(), 'utf8')) as Partial<Record<BackendId, BackendModelPreference>>
    } catch {
      this.defaultModels = {}
    }
  }

  setDefaultModels(defaults: Partial<Record<BackendId, BackendModelPreference>>): void {
    this.defaultModels = { ...defaults }
    try {
      writeFileSync(this.defaultModelsFile(), JSON.stringify(this.defaultModels, null, 2))
    } catch {
      /* Defaults keep working in memory if persistence is unavailable. */
    }
  }

  private assertLabIdle(): void {
    if ([...this.bindings.values()].some((binding) => binding.backendId === 'lab' && this.busyThreads.has(binding.id))) {
      throw new Error('Wait for running Lab threads to finish before changing API connections.')
    }
  }

  private labConnections(): LabConnectionsSettings {
    const lab = this.backends.lab
    if (!lab.labConnections) throw new Error('Lab API connections are not available in this build.')
    return lab.labConnections()
  }

  private async saveLabConnection(connection: LabConnectionUpdate): Promise<LabConnectionsSettings> {
    this.assertLabIdle()
    const lab = this.backends.lab
    if (!lab.saveLabConnection) throw new Error('Lab API connections are not available in this build.')
    return lab.saveLabConnection(connection)
  }

  private async deleteLabConnection(connectionId: string): Promise<LabConnectionsSettings> {
    this.assertLabIdle()
    const lab = this.backends.lab
    if (!lab.deleteLabConnection) throw new Error('Lab API connections are not available in this build.')
    const settings = await lab.deleteLabConnection(connectionId)
    this.loadDefaultModels()
    if (this.defaultModels?.lab?.providerID === connectionId) {
      const defaults = { ...this.defaultModels }
      delete defaults.lab
      this.setDefaultModels(defaults)
    }
    return settings
  }

  defaultModel(backendId: BackendId): BackendModelPreference | undefined {
    this.loadDefaultModels()
    const preference = this.defaultModels?.[backendId]
    return preference ? { ...preference } : undefined
  }

  titleSettings(patch?: Partial<ThreadTitleSettings>): ThreadTitleSettings {
    this.load()
    if (patch) {
      this.threadTitleSettings = { ...this.threadTitleSettings, ...patch }
      this.save()
    }
    return { ...this.threadTitleSettings }
  }

  sandbox(patch?: Partial<SandboxSettings>): SandboxSettings {
    this.load()
    if (patch) {
      this.sandboxSettings = { ...this.sandboxSettings, ...patch }
      this.save()
      // Backends read the sandbox per turn, so the next message picks this up.
      // Codex is the only backend that sandboxes today.
      this.applySandboxSettings()
    }
    return { ...this.sandboxSettings }
  }

  isThreadBusy(threadId: string): boolean {
    return this.busyThreads.has(threadId)
  }

  createScopedThread(
    backendId: BackendId,
    scope: ProjectScope,
    title: string,
    worktree?: WorktreeInfo
  ): Promise<SessionInfo> {
    return this.sessionCreateInScope(backendId, scope, title, undefined, worktree)
  }

  attachAutomations(automations: { handle(request: BackendRequest): Promise<unknown> }): void {
    this.automations = automations
  }

  attachMcpHub(mcpHub: { handle(request: BackendRequest): Promise<unknown> }): void {
    this.mcpHub = mcpHub
  }

  attachMobile(mobile: { handle(request: BackendRequest): Promise<unknown> }): void {
    this.mobile = mobile
  }

  attachRemote(remote: { handle(request: BackendRequest): Promise<unknown> }): void {
    this.remote = remote
  }

  attachTelegram(telegram: { handle(request: BackendRequest): Promise<unknown> }): void {
    this.telegram = telegram
  }

  attachBinaryOverrides(overrides: BinaryOverrides): void {
    this.binaryOverrides = overrides
  }

  /** Where each backend's CLI lives, keyed by backend id rather than command name so
   *  the renderer never has to know a backend's command. Backends with no command of
   *  their own (opencode runs as a server) are absent. */
  private binaryPaths(): Partial<Record<BackendId, string>> {
    const stored = this.binaryOverrides?.all() ?? {}
    const paths: Partial<Record<BackendId, string>> = {}
    for (const id of Object.keys(DEFINITIONS) as BackendId[]) {
      const command = DEFINITIONS[id].command
      if (command && stored[command]) paths[id] = stored[command]
    }
    return paths
  }

  /** Record where a backend's CLI lives. An empty path clears the override and returns
   *  the backend to a plain PATH lookup. */
  private setBinaryPath(backendId: BackendId, path: string | undefined): Partial<Record<BackendId, string>> {
    if (!this.binaryOverrides) throw new Error('Backend locations are not available.')
    const command = DEFINITIONS[backendId].command
    if (!command) throw new Error(`${DEFINITIONS[backendId].label} does not run from a CLI on PATH.`)
    this.binaryOverrides.set(command, path)
    // probeVersion runs on every descriptors() call rather than being cached, so the
    // next backend.list already reflects this. The renderer reloads that after saving,
    // which is what clears a stale "Unavailable".
    return this.binaryPaths()
  }

  async start(projectPath?: string): Promise<void> {
    this.load()
    if (projectPath) this.projectPath = projectPath
    // Best-effort: a missing or unhealthy opencode must not abort startup. This
    // call is awaited inside an unawaited block in index.ts, so throwing here
    // silently skipped mcpHub, automations, and webAccess.
    await this.ensureStarted('opencode').catch((error) => {
      process.stderr.write(`[backend] opencode unavailable: ${error instanceof Error ? error.message : String(error)}\n`)
    })
    await this.threadBus?.resume()
    for (const binding of this.bindings.values()) {
      if (binding.followUps?.length) void this.deliverNextFollowUp(binding.id)
    }
    await this.cleanupWorktrees()
    this.worktreeCleanupTimer = setInterval(() => void this.cleanupWorktrees(), 6 * 60 * 60 * 1_000)
    this.worktreeCleanupTimer.unref()
  }

  async stop(): Promise<void> {
    await Promise.all((Object.keys(this.backends) as BackendId[]).map((id) => this.backends[id].stop().catch(() => {})))
    this.started.clear()
    for (const off of this.unsubscribers.values()) off()
    this.unsubscribers.clear()
    await this.threadBus?.stop()
    if (this.worktreeCleanupTimer) clearInterval(this.worktreeCleanupTimer)
    this.worktreeCleanupTimer = undefined
    this.transcripts?.close()
  }

  async setProject(path: string): Promise<void> {
    this.projectPath = path
    for (const id of this.started) await this.backends[id].setProject(path)
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed = JSON.parse(readFileSync(stateFile(), 'utf8')) as StoredBackendState | PreviousBackendState | LegacyBackendState
      if ((parsed.version === 2 || parsed.version === 3) && Array.isArray(parsed.threads)) {
        for (const binding of parsed.threads) this.bindings.set(binding.id, binding)
        if (parsed.version === 3 && parsed.threadTitleSettings) {
          this.threadTitleSettings = { ...DEFAULT_THREAD_TITLE_SETTINGS, ...parsed.threadTitleSettings }
        }
        if (parsed.version === 3 && parsed.sandboxSettings) {
          this.sandboxSettings = { ...DEFAULT_SANDBOX_SETTINGS, ...parsed.sandboxSettings }
        }
      } else if (parsed.version === 1 && Array.isArray(parsed.threads)) {
        for (const legacy of parsed.threads) {
          const scope = projectScope(legacy.projectPath)
          const binding: ThreadBinding = {
            ...legacy,
            nativeSessionOwnership: legacy.backendId === 'opencode' ? 'imported' : 'boss',
            projectId: scope.projectId,
            projectPath: scope.projectPath,
            executionPath: scope.executionPath
          }
          this.bindings.set(binding.id, binding)
        }
        this.save()
      }
    } catch {
      /* Preserve pre-BOSS OpenCode sessions once on first launch or migration. */
      /* First BOSS launch starts with no thread bindings. */
    }
    this.migrateLegacyCodexParts()
  }

  private migrateLegacyCodexParts(): void {
    if (!this.transcripts || this.transcripts.metadata('migration.codex-live-parts.v1') === 'complete') return
    try {
      const parsed = JSON.parse(readFileSync(join(app.getPath('userData'), 'codex-live-parts.json'), 'utf8')) as {
        version?: number
        threads?: Record<string, Record<string, Part[]>>
      }
      if (parsed.version === 1 && parsed.threads) {
        for (const [nativeSessionId, messages] of Object.entries(parsed.threads)) {
          const binding = this.bindingForNative('codex', nativeSessionId)
          if (!binding) continue
          for (const parts of Object.values(messages)) {
            for (const part of parts) this.transcripts.recordPart(this.transcriptSource(binding), part)
          }
        }
        this.transcripts.flush()
      }
    } catch {
      /* No legacy cache is the normal case on a fresh install. */
    }
    this.transcripts.setMetadata('migration.codex-live-parts.v1', 'complete')
  }

  private save(): void {
    const state: StoredBackendState = {
      version: 3,
      threads: [...this.bindings.values()],
      threadTitleSettings: this.threadTitleSettings,
      sandboxSettings: this.sandboxSettings
    }
    try {
      writeFileSync(stateFile(), JSON.stringify(state, null, 2))
    } catch {
      /* Threads keep working in memory if persistence is unavailable. */
    }
  }

  /** Push the sandbox preference to every backend that sandboxes. */
  private applySandboxSettings(): void {
    for (const backend of Object.values(this.backends)) {
      backend?.setSandbox?.(this.sandboxSettings)
    }
  }

  private async ensureStarted(id: BackendId): Promise<Backend> {
    const backend = this.backends[id]
    if (!backend) throw new Error(`Unknown backend: ${id}`)
    // A backend built after the state file loaded starts on the default, so
    // set it here rather than only when the setting changes.
    backend.setSandbox?.(this.sandbox())
    if (!this.unsubscribers.has(id)) {
      this.unsubscribers.set(id, backend.onEvent((event) => this.forwardEvent(id, event)))
    }
    if (this.started.has(id)) return backend
    const pending = this.starting.get(id)
    if (pending) return pending
    const start = (async () => {
      try {
        await backend.start()
        if (this.projectPath) await backend.setProject(this.projectPath)
        this.started.add(id)
        return backend
      } catch (error) {
        await backend.stop().catch(() => {})
        throw error
      }
    })()
    this.starting.set(id, start)
    try {
      return await start
    } finally {
      this.starting.delete(id)
    }
  }

  /** End the runs a backend was working on when its server went away.
   *
   *  Nothing is going to finish them, and nothing else will say so: the idle
   *  event that normally settles a run dies with the process. A thread left
   *  busy shows Working for ever, and — since main refuses a second run on a
   *  busy thread — cannot be written to again either. */
  private settleRunsOn(backendId: BackendId): void {
    for (const threadId of [...this.busyThreads]) {
      const binding = this.bindings.get(threadId)
      if (binding?.backendId !== backendId) continue
      this.busyThreads.delete(threadId)
      this.intentionalAborts.delete(threadId)
      this.transcripts?.finishRun(this.transcriptSource(binding), 'error')
      this.emit({
        type: 'session.status',
        properties: { sessionID: threadId, status: { type: 'idle' } },
        backendId
      })
      this.emit({
        type: 'session.idle',
        // The run did not finish, it was lost with the server. Say so, or the
        // task policy reads this idle as a clean finish and reviews work that
        // never completed instead of falling back.
        properties: { sessionID: threadId, lost: true },
        backendId
      })
    }
  }

  /** Stop a backend's server and start it again.
   *
   *  A backend server reads its credentials when it starts and keeps them for
   *  as long as it runs. Signing in to a different account therefore leaves the
   *  running server holding a token for the account that just signed out, and
   *  every request fails with an authentication error even though the CLI is
   *  signed in correctly. Restarting the server is what picks the new
   *  credentials up, and it also clears a server that has otherwise wedged.
   *
   *  Refused while a thread on that backend is mid-run, since stopping the
   *  server would abandon the reply that run is producing. */
  async restartBackend(id: BackendId): Promise<BackendDescriptor[]> {
    const backend = this.backends[id]
    if (!backend) throw new Error(`Unknown backend: ${id}`)
    const busy = [...this.busyThreads].some((threadId) => this.bindings.get(threadId)?.backendId === id)
    if (busy) throw new Error(`Wait for the running ${DEFINITIONS[id].label} thread to finish before restarting it.`)
    await this.starting.get(id)?.catch(() => { /* a failed start still leaves nothing running */ })
    this.started.delete(id)
    await backend.stop().catch(() => { /* a server that is already gone is the state we want */ })
    // Started on demand rather than here, so a backend nothing is using does
    // not get spun back up merely because it was restarted.
    return this.descriptors()
  }

  private binding(threadId: string): ThreadBinding {
    const binding = this.bindings.get(threadId)
    if (!binding) throw new Error(`BOSS thread not found: ${threadId}`)
    this.backends[binding.backendId].setSessionDirectory?.(binding.nativeSessionId, binding.executionPath)
    if (binding.worktree?.status === 'active') void this.worktrees?.touch(binding.worktree.id)
    return binding
  }

  private bindingForNative(backendId: BackendId, nativeSessionId?: string): ThreadBinding | undefined {
    if (!nativeSessionId) return undefined
    return [...this.bindings.values()].find(
      (binding) => binding.backendId === backendId && binding.nativeSessionId === nativeSessionId
    )
  }

  private transcriptSource(binding: ThreadBinding) {
    return {
      threadId: binding.id,
      backendId: binding.backendId,
      nativeSessionId: binding.nativeSessionId
    }
  }

  private session(binding: ThreadBinding, native?: SessionInfo): SessionInfo {
    return {
      ...native,
      id: binding.id,
      backendId: binding.backendId,
      nativeSessionId: binding.nativeSessionId,
      nativeSessionOwnership: binding.nativeSessionOwnership,
      projectId: binding.projectId,
      projectPath: binding.projectPath,
      executionPath: binding.executionPath,
      archived: binding.archived === true,
      title: binding.title ?? native?.title,
      directory: binding.executionPath || native?.directory,
      path: binding.executionPath || native?.path,
      parentID: binding.parentID,
      lineage: binding.lineage,
      worktree: binding.worktree,
      mode: this.modeFor(binding),
      busy: this.busyThreads.has(binding.id),
      model: binding.model
        ? { id: binding.model.modelID, provider: binding.model.providerID }
        : native?.model,
      time: native?.time ?? { created: binding.createdAt, updated: binding.updatedAt }
    }
  }

  private registerNative(
    backendId: BackendId,
    native: SessionInfo,
    nativeSessionOwnership: ThreadBinding['nativeSessionOwnership'],
    lineage?: SessionInfo['lineage']
  ): ThreadBinding {
    const existing = this.bindingForNative(backendId, native.id)
    if (existing) {
      existing.title = native.title ?? existing.title
      existing.updatedAt = native.time?.updated ?? now()
      if (native.directory) {
        const scope = projectScope(native.directory)
        existing.projectId = scope.projectId
        existing.projectPath = scope.projectPath
        existing.executionPath = scope.executionPath
      }
      this.bindings.set(existing.id, existing)
      return existing
    }
    const executionPath = native.directory || this.projectPath
    const scope = projectScope(executionPath)
    const binding: ThreadBinding = {
      id: randomUUID(),
      backendId,
      nativeSessionId: native.id,
      nativeSessionOwnership,
      projectId: scope.projectId,
      projectPath: scope.projectPath,
      executionPath: scope.executionPath,
      title: native.title,
      createdAt: native.time?.created ?? now(),
      updatedAt: native.time?.updated ?? now(),
      lineage
    }
    this.bindings.set(binding.id, binding)
    return binding
  }

  private normalizeEvent(event: EventMessage | Record<string, unknown>): Record<string, unknown> {
    const value = event as Record<string, unknown>
    if (value.properties && typeof value.properties === 'object') return value
    switch (value.type) {
      case 'message.updated': return { type: value.type, properties: { info: value.message } }
      case 'message.part.updated':
      case 'message.part.created': return { type: value.type, properties: { part: value.part } }
      case 'session.updated':
      case 'session.created':
      case 'session.deleted': return { type: value.type, properties: { info: value.session } }
      case 'session.todo.updated': return { type: 'todo.updated', properties: { sessionID: value.sessionID, todos: value.todos } }
      case 'permission.asked':
      case 'permission.updated': return { type: value.type, properties: value.permission ?? {} }
      case 'permission.replied': return { type: value.type, properties: { sessionID: value.sessionID, permissionID: value.permissionID, response: value.response } }
      case 'question.asked': return { type: value.type, properties: value.question ?? {} }
      case 'question.replied': return { type: value.type, properties: { sessionID: value.sessionID, requestID: value.requestID } }
      case 'question.rejected': return { type: value.type, properties: { sessionID: value.sessionID, requestID: value.requestID } }
      case 'session.status': return { type: value.type, properties: { sessionID: value.sessionID, status: value.status } }
      case 'session.idle':
      case 'session.compacted': return { type: value.type, properties: { sessionID: value.sessionID } }
      case 'session.error': return { type: value.type, properties: { sessionID: value.sessionID, error: value.error } }
      default: return value
    }
  }

  private forwardEvent(backendId: BackendId, raw: EventMessage | Record<string, unknown>): void {
    const event = this.normalizeEvent(raw)
    const properties = { ...((event.properties as Record<string, unknown> | undefined) ?? {}) }
    const eventType = String(event.type ?? '')
    const info = (properties.info ?? properties.session) as SessionInfo | undefined
    const sessionInfo = eventType === 'session.updated' || eventType === 'session.created' || eventType === 'session.deleted'
      ? info
      : undefined
    const messageInfo = eventType === 'message.updated'
      ? info as unknown as { sessionID?: string }
      : undefined
    const part = properties.part as { sessionID?: string; messageID?: string } | undefined
    const nativeId = (properties.sessionID as string | undefined) ?? sessionInfo?.id ?? messageInfo?.sessionID ?? part?.sessionID
    // A backend whose process is gone must be startable again. Without this the
    // started set kept a dead backend marked as running, so ensureStarted
    // handed back a backend with no process and every later request failed
    // until BOSS itself was restarted.
    if (eventType === 'server.disconnected') {
      this.started.delete(backendId)
      this.settleRunsOn(backendId)
    }
    const binding = this.bindingForNative(backendId, nativeId)
    if (!binding && nativeId) return
    if (binding) {
      if (sessionInfo) {
        properties.info = this.session(binding, sessionInfo)
        binding.title = sessionInfo.title ?? binding.title
        binding.updatedAt = sessionInfo.time?.updated ?? now()
        this.save()
      }
      if (properties.sessionID) properties.sessionID = binding.id
      if (part) properties.part = { ...part, sessionID: binding.id }
      if (messageInfo?.sessionID) properties.info = { ...messageInfo, sessionID: binding.id }
      if (eventType === 'message.updated' && properties.info) {
        // Remember which assistant message is current so an image emitted as
        // its own part can join it rather than a message of its own. Read from
        // the same event the transcript records, so the id is one the renderer
        // will group by and not a guess about the backend's naming.
        const info = properties.info as MessageWithParts['info']
        if (info.role === 'assistant' && typeof info.id === 'string' && info.id) {
          binding.lastAssistantMessageId = info.id
        }
        this.transcripts?.recordMessage(
          this.transcriptSource(binding),
          properties.info as MessageWithParts['info']
        )
      } else if ((eventType === 'message.part.updated' || eventType === 'message.part.created') && properties.part) {
        // Images inside a tool result become their own parts before the
        // transcript sees this one. Done here rather than in a backend because
        // the store lives on the manager, and because a part arriving from any
        // backend gets the same treatment. It also keeps the base64 out of
        // SQLite: what is recorded below is the stripped part.
        properties.part = this.extractToolResultImages(
          binding,
          properties.part as MessageWithParts['parts'][number]
        )
        this.transcripts?.recordPart(
          this.transcriptSource(binding),
          properties.part as MessageWithParts['parts'][number]
        )
        this.publishTodosAfterToolCall(binding, properties.part as MessageWithParts['parts'][number])
      }
      if (eventType === 'session.status') {
        const status = (properties.status as { type?: string } | undefined)?.type
        // A new run writes new messages, so the message an image should join is
        // not known again until the backend reports one. Keeping the previous
        // run's id would hang an image off a turn that has already been drawn.
        if (status === 'busy') binding.lastAssistantMessageId = undefined
        if (status === 'busy' || status === 'retry') {
          if (!this.busyThreads.has(binding.id)) {
            this.transcripts?.beginRun(this.transcriptSource(binding))
          }
          this.busyThreads.add(binding.id)
          if (binding.attention && binding.attention.kind !== 'permission' && binding.attention.kind !== 'question') {
            binding.attention = undefined
            this.save()
          }
        } else {
          this.transcripts?.finishRun(this.transcriptSource(binding), 'completed')
          this.busyThreads.delete(binding.id)
        }
      } else if (eventType === 'session.idle') {
        // A run whose server died is reported as idle so the thread stops
        // showing Working, but it did not finish. Settle it as an error, so the
        // fallback answers it and no reviewer reads unfinished work as done.
        const lost = properties.lost === true
        const stopped = properties.stopped === true
        this.transcripts?.finishRun(this.transcriptSource(binding), lost ? 'error' : 'completed')
        this.busyThreads.delete(binding.id)
        void this.threadBus?.flush(binding.id)
        void this.deliverNextFollowUp(binding.id)
        this.setThreadAttention(binding, lost ? 'error' : 'completed', lost ? 'The backend server went away mid-run.' : undefined)
        // A run the user stopped settles nothing: it is neither work to review
        // nor a failure to fall back from.
        if (!stopped) this.settleRun(binding, lost ? 'error' : 'completed')
      } else if (eventType === 'session.error') {
        // A backend BOSS stopped on purpose reports that stop as an error.
        // Stop, and Stop & redirect, both end this way, and showing the user
        // "Aborted" for something they asked for reads as a failure. Only the
        // abort itself is swallowed: any other error from the stopped thread
        // is a real one and still surfaces.
        if (this.intentionalAborts.has(binding.id) && isAbortError(properties.error)) {
          this.intentionalAborts.delete(binding.id)
          // Ended, not failed: settle the run the way idle does. Stop &
          // redirect leaves the instruction queued, and this may be the only
          // event that says the stop happened, so deliver it here rather than
          // waiting for an idle the backend may never send.
          this.transcripts?.finishRun(this.transcriptSource(binding), 'completed')
          this.busyThreads.delete(binding.id)
          void this.threadBus?.flush(binding.id)
          void this.deliverNextFollowUp(binding.id)
          return
        }
        this.transcripts?.finishRun(this.transcriptSource(binding), 'error')
        this.busyThreads.delete(binding.id)
        this.setThreadAttention(binding, 'error', this.errorDetail(properties.error))
        // A stop the user asked for is handled above and never reaches here, so
        // this is a real failure and the fallback should answer it.
        this.settleRun(binding, 'error')
      } else if (eventType === 'permission.asked' || eventType === 'permission.updated') {
        // Read the mode now, not at spawn. This is the whole fix: whatever the
        // backend was launched under, the answer follows the mode the thread is
        // in at the moment the request arrives.
        const hostResponse = this.hostPermissionResponse(binding)
        const permissionId = properties.id as string | undefined
        if (hostResponse && permissionId) {
          void this.handle({
            type: 'thread.permission',
            threadId: binding.id,
            permissionId,
            response: hostResponse
          }).catch(() => { /* the run may have ended before the answer landed */ })
          // Swallow the event so no surface prompts for something already answered.
          return
        }
        this.setThreadAttention(binding, 'permission')
      } else if (eventType === 'permission.replied') {
        if (binding.attention?.kind === 'permission') this.clearThreadAttention(binding)
      } else if (eventType === 'question.asked') {
        this.setThreadAttention(binding, 'question')
      } else if (eventType === 'question.replied' || eventType === 'question.rejected') {
        if (binding.attention?.kind === 'question') this.clearThreadAttention(binding)
      }
    }
    this.emit({ ...event, properties, backendId })
  }

  async descriptors(): Promise<BackendDescriptor[]> {
    return (Object.keys(DEFINITIONS) as BackendId[]).map((id) => {
      const definition = DEFINITIONS[id]
      const probe = definition.command ? probeVersion(definition.command) : { available: true }
      const info = this.backends[id].info()
      return {
        id,
        label: definition.label,
        description: definition.description,
        command: definition.command,
        available: probe.available,
        healthy: this.started.has(id) ? info.healthy : probe.available,
        version: info.version || probe.version,
        unavailableReason: probe.reason,
        // Only worth asking once the CLI actually ran: an absent binary is
        // already reported through unavailableReason, and saying both would
        // blame the version for a missing install.
        versionWarning: probe.available
          ? backendVersionWarning(id, info.version || probe.version)
          : undefined,
        capabilities: definition.capabilities,
        modes: definition.modes
      }
    })
  }

  async sessionsList(): Promise<SessionInfo[]> {
    this.load()
    // Only opencode-owned threads need enriching, so do not spin opencode up
    // just to list sessions belonging to other backends.
    const needsOpenCode = [...this.bindings.values()].some((binding) => binding.backendId === 'opencode')
    const nativeSessions = needsOpenCode
      ? await this.ensureStarted('opencode').then((backend) => backend.sessionsList()).catch(() => [])
      : []
    // Every thread, not just the open project's: the sidebar lists threads
    // under each project, so filtering here left the others permanently empty.
    return [...this.bindings.values()]
      .map((binding) => {
        const native = binding.backendId === 'opencode'
          ? nativeSessions.find((session) => session.id === binding.nativeSessionId)
          : undefined
        return this.session(binding, native)
      })
      .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
  }

  async sessionCreate(
    backendId: BackendId,
    title?: string,
    lineage?: SessionInfo['lineage'],
    creationScope: ThreadCreationScope = 'current'
  ): Promise<SessionInfo> {
    const scope = creationScope === 'global' ? this.globalScope : this.currentScope
    return this.sessionCreateInScope(backendId, scope, title, lineage)
  }

  private async sessionCreateInScope(
    backendId: BackendId,
    scope: ProjectScope,
    title?: string,
    lineage?: SessionInfo['lineage'],
    worktree?: WorktreeInfo
  ): Promise<SessionInfo> {
    const backend = await this.ensureStarted(backendId)
    const native = await backend.sessionCreate(title, scope.executionPath || undefined)
    const binding = this.registerNative(backendId, native, 'boss', lineage)
    binding.title = title ?? native.title
    binding.projectId = scope.projectId
    binding.projectPath = scope.projectPath
    binding.executionPath = scope.executionPath
    binding.worktree = worktree
    // What the first message will run on, recorded now so a thread that is
    // created and left idle still shows its real model rather than the app's.
    // sendMessage resolves the same default, so the two cannot disagree.
    binding.model = boundModel(this.defaultModel(backendId))
    this.bindings.set(binding.id, binding)
    this.save()
    const session = this.session(binding, native)
    this.emit({ type: 'session.created', properties: { info: session }, backendId })
    return session
  }

  async sessionGet(threadId: string): Promise<SessionInfo> {
    const binding = this.binding(threadId)
    const backend = await this.ensureStarted(binding.backendId)
    const native = await backend.sessionGet(binding.nativeSessionId).catch(() => ({ id: binding.nativeSessionId }))
    return this.session(binding, native)
  }

  async setEmptyThreadBackend(threadId: string, backendId: BackendId): Promise<SessionInfo> {
    const binding = this.binding(threadId)
    if (binding.backendId === backendId) return this.sessionGet(threadId)
    if (this.busyThreads.has(threadId) || binding.followUps?.length) {
      throw new Error('Wait for this thread to finish before changing its backend.')
    }
    if (this.transcripts?.messages(threadId).some((message) => message.info.role === 'user')) {
      throw new Error('Only a blank thread can change backends. Continue it in another backend instead.')
    }

    const previousBackend = await this.ensureStarted(binding.backendId)
    const nativeMessages = await previousBackend.messagesList(binding.nativeSessionId)
    if (nativeMessages.some((message) => message.info.role === 'user')) {
      throw new Error('Only a blank thread can change backends. Continue it in another backend instead.')
    }

    const nextBackend = await this.ensureStarted(backendId)
    const nextNative = await nextBackend.sessionCreate(binding.title, binding.executionPath || undefined)
    const previousNativeSessionId = binding.nativeSessionId
    const previousOwnership = binding.nativeSessionOwnership
    binding.backendId = backendId
    binding.nativeSessionId = nextNative.id
    binding.nativeSessionOwnership = 'boss'
    if (previousOwnership === 'boss') {
      // The binding already points at the replacement so an old backend's
      // session.deleted event cannot remove the preserved BOSS thread.
      await previousBackend.sessionDelete(previousNativeSessionId).catch(() => {})
    }

    binding.title = binding.title ?? nextNative.title
    // The old backend's model cannot describe the new one, and this thread is
    // blank, so it takes the incoming backend's default like a fresh thread.
    binding.model = boundModel(this.defaultModel(backendId))
    binding.updatedAt = now()
    this.transcripts?.deleteThread(threadId)
    this.save()
    const session = this.session(binding, nextNative)
    this.emit({ type: 'session.updated', properties: { info: session }, backendId })
    return session
  }

  async sessionDelete(threadId: string): Promise<void> {
    const binding = this.binding(threadId)
    if (binding.nativeSessionOwnership === 'boss') {
      // Best effort, like the rename below. The thread is BOSS's own record, so
      // a backend that cannot be started or cannot answer must not be able to
      // keep it: a server that was down or signed out of the wrong account left
      // its threads undeletable, and the renderer showed nothing at all.
      await this.ensureStarted(binding.backendId)
        .then((backend) => backend.sessionDelete(binding.nativeSessionId))
        .catch(() => { /* the native session outlives BOSS's record of it */ })
    }
    this.transcripts?.deleteThread(threadId)
    // The images belonged to the transcript, so they go with it rather than
    // sitting in userData for a thread that no longer exists.
    this.images?.forget(threadId)
    this.pruneSuspended.delete(threadId)
    this.bindings.delete(threadId)
    this.save()
    this.emit({ type: 'session.deleted', properties: { info: this.session(binding) }, backendId: binding.backendId })
  }

  async sessionRename(threadId: string, title: string): Promise<SessionInfo> {
    const binding = this.binding(threadId)
    const backend = await this.ensureStarted(binding.backendId)
    const native = await backend.sessionRename(binding.nativeSessionId, title).catch(() => ({ id: binding.nativeSessionId, title }))
    binding.title = title
    binding.updatedAt = now()
    this.save()
    const session = this.session(binding, native)
    this.emit({ type: 'session.updated', properties: { info: session }, backendId: binding.backendId })
    return session
  }

  async messagesList(threadId: string, limit?: number): Promise<MessageWithParts[]> {
    const binding = this.binding(threadId)
    let messages: MessageWithParts[]
    try {
      const backend = await this.ensureStarted(binding.backendId)
      messages = await backend.messagesList(binding.nativeSessionId)
    } catch (error) {
      if (this.transcripts?.hasMessages(threadId)) return this.transcripts.messages(threadId, limit)
      throw error
    }
    const normalized = messages.map((message) => ({
      info: { ...message.info, sessionID: threadId },
      parts: message.parts.map((part) => ({ ...part, sessionID: threadId }))
    }))
    if (!this.transcripts) return limit ? normalized.slice(-limit) : normalized
    this.transcripts.reconcile(this.transcriptSource(binding), normalized, {
      // Pruning deletes for real, so it needs two things to be true: the thread
      // is idle, and the backend's history is actually complete. A failed send
      // breaks the second — BOSS recorded a message the backend never received.
      pruneMissingMessages: !this.busyThreads.has(threadId) && !this.pruneSuspended.has(threadId)
    })
    return this.transcripts.messages(threadId, limit)
  }

  async sendMessage(threadId: string, parts: unknown[], options?: BackendMessageOptions): Promise<void> {
    const binding = this.binding(threadId)
    // Stranded, not merely removed. A thread that left its worktree is back in
    // its project and can carry on; one whose worktree was reaped underneath it
    // still points into a directory that is gone. Both end with status
    // 'removed', so the check is where the thread actually is.
    if (binding.worktree?.status === 'removed' && binding.executionPath === binding.worktree.path) {
      throw new Error('This thread\'s worktree was cleaned up. Fork it into a new worktree before continuing.')
    }
    // One run per thread. The renderer decides between sending and queueing
    // from its own copy of the busy state, which is a snapshot: two sends in
    // quick succession both read "idle" and both started a run, and the second
    // transcript reload then replaced the first message with whatever the
    // backend had recorded. Only main knows, and it knows synchronously.
    if (this.busyThreads.has(threadId) && !this.followUpDeliveries.has(threadId)) {
      throw new Error(THREAD_BUSY_ERROR)
    }
    const usage = this.transcripts?.usage(threadId).totals ?? { runs: 0, durationMs: 0, tokenRuns: 0, toolCalls: 0 }
    const violation = budgetViolation(binding.policy, usage)
    if (violation) throw new Error(`${violation} Increase or remove the task budget before continuing.`)
    const backend = await this.ensureStarted(binding.backendId)
    const generatedTitle = this.threadTitleSettings.autoNameFromFirstPrompt
      ? titleFromFirstPrompt(binding.title, parts)
      : undefined
    if (generatedTitle) {
      // Persist BOSS's own title first. A backend-native title may later replace
      // it through session.updated, but backends without title generation now
      // have a useful name without a second model turn.
      binding.title = generatedTitle
      binding.updatedAt = now()
      this.save()
      this.emit({
        type: 'session.updated',
        properties: { info: this.session(binding) },
        backendId: binding.backendId
      })
      await backend.sessionRename(binding.nativeSessionId, generatedTitle).catch(() => {})
    }
    // A caller that names a mode is setting the thread's mode, not passing a
    // one-off. Recording it here keeps the stored mode and the mode the backend
    // launches under from drifting apart.
    if (options?.mode) binding.mode = options.mode
    // Same for the model. A thread created by an agent resolves its model from
    // the backend defaults here in main, so this is the only place that copy
    // exists for the renderer to display.
    if (options?.model) binding.model = boundModel(options.model)
    binding.updatedAt = now()
    this.save()
    this.transcripts?.beginRun(this.transcriptSource(binding))
    // Carried as a message part, not only in the context prompt: opencode and
    // pi have no system-prompt hook and drop that field entirely. A goal is the
    // task itself rather than a fact about the checkout, so it has to reach
    // every backend. Without this, a thread told to "do the task in the goal"
    // has nowhere to read it and searches the disk for a goal file.
    const goalParts = binding.policy?.goal
      ? [{ type: 'text', text: `Standing goal for this thread: ${binding.policy.goal}` }, ...parts]
      : parts
    // A new run cannot be excused by the last stop, so an abort error after
    // this point is the backend's own and reaches the user.
    this.intentionalAborts.delete(threadId)
    // This send is reaching the backend, so whatever it stores from here is
    // authoritative again. Left set, a single failed send would disable
    // pruning for the life of the thread and let deleted messages linger.
    this.pruneSuspended.delete(threadId)
    this.busyThreads.add(threadId)
    // Do not make visible activity depend on how quickly (or whether) a
    // backend echoes its native busy event. Native events will subsequently
    // reconcile this optimistic state and carry the streamed transcript.
    this.emit({
      type: 'session.status',
      properties: { sessionID: threadId, status: { type: 'busy' } },
      backendId: binding.backendId
    })
    try {
      // Built here rather than in each backend: the manager is what knows
      // which project a thread belongs to.
      await backend.sendMessage(binding.nativeSessionId, goalParts, {
        ...options,
        context: options?.context ?? threadContextPrompt({
          projectName: binding.projectPath ? basename(binding.projectPath) : undefined,
          projectPath: binding.projectPath,
          executionPath: binding.executionPath,
          branch: binding.worktree?.branch,
          worktree: binding.worktree?.status === 'active'
        })
      })
    } catch (error) {
      // A backend that refuses because it is still running has not started a
      // run to settle. Its own turn slot outlives main's busy flag, so a
      // message sent in that gap gets here — and settling it marked the live
      // run's parts interrupted, announced idle over a thread that was still
      // streaming, and let the next reload prune as if the thread were done.
      // That reload is what deleted the message the user had just sent.
      if (error instanceof Error && error.message.includes(THREAD_BUSY_ERROR)) throw error
      this.transcripts?.finishRun(this.transcriptSource(binding), 'error')
      // The send failed, so whatever the backend has stored is what it had
      // before this message — and clearing busy hands the next reload a licence
      // to prune. Any throw that is not a busy refusal (network, auth,
      // transport) reached here and deleted the message the user had just sent,
      // because only the busy case returned above. Settle the run without
      // arming the prune: the thread is idle, but its native history is not
      // authoritative about a message it was never told about.
      this.pruneSuspended.add(threadId)
      this.busyThreads.delete(threadId)
      this.emit({
        type: 'session.status',
        properties: { sessionID: threadId, status: { type: 'idle' } },
        backendId: binding.backendId
      })
      throw error
    }
  }

  private emitFollowUps(binding: ThreadBinding): void {
    this.emit({
      type: 'thread.followups.updated',
      properties: { threadId: binding.id, followUps: binding.followUps ?? [] },
      backendId: binding.backendId
    })
  }

  /** Show a steered message in the transcript as soon as it is accepted.
   *  A backend that steers folds the text into the run it is already doing,
   *  and reports it only when that run ends — so without this the message the
   *  user just sent left the queue and appeared nowhere until the reply came. */
  private echoSteeredMessage(binding: ThreadBinding, item: QueuedFollowUp): void {
    const messageId = `steer-${item.id}`
    const info = {
      id: messageId,
      sessionID: binding.id,
      role: 'user' as const,
      time: { created: now() }
    }
    this.transcripts?.recordMessage(this.transcriptSource(binding), info)
    this.emit({
      type: 'message.updated',
      properties: { info },
      backendId: binding.backendId
    })
    const parts: Part[] = [
      ...item.attachments.map((attachment, index) => ({
        id: `${messageId}-file-${index}`,
        type: 'file' as const,
        sessionID: binding.id,
        messageID: messageId,
        // Carrying the image itself, not just its name: the transcript shows
        // what was attached rather than reporting that something was.
        state: {
          status: 'completed' as const,
          path: attachment.name,
          name: attachment.name,
          ...(attachment.mime?.startsWith('image/') ? { mime: attachment.mime, url: attachment.dataUrl } : {})
        }
      })),
      ...(item.text.trim()
        ? [{
            id: `${messageId}-text`,
            type: 'text' as const,
            sessionID: binding.id,
            messageID: messageId,
            text: item.text
          }]
        : [])
    ]
    for (const part of parts) {
      this.transcripts?.recordPart(this.transcriptSource(binding), part)
      this.emit({
        type: 'message.part.updated',
        properties: { part },
        backendId: binding.backendId
      })
    }
  }

  private followUpParts(item: QueuedFollowUp): unknown[] {
    return [
      ...item.attachments.map((attachment) => ({
        type: 'file',
        mime: attachment.mime,
        filename: attachment.name,
        url: attachment.dataUrl
      })),
      ...(item.text.trim() ? [{ type: 'text', text: item.text }] : [])
    ]
  }

  followUps(threadId: string): QueuedFollowUp[] {
    return [...(this.binding(threadId).followUps ?? [])]
  }

  async addFollowUp(
    threadId: string,
    text: string,
    attachments: QueuedFollowUpAttachment[] = [],
    options?: BackendMessageOptions
  ): Promise<QueuedFollowUp[]> {
    if (!text.trim() && attachments.length === 0) throw new Error('A follow-up message is required.')
    const binding = this.binding(threadId)
    const item: QueuedFollowUp = {
      id: randomUUID(),
      threadId,
      text,
      attachments,
      options,
      createdAt: now()
    }
    binding.followUps = [...(binding.followUps ?? []), item]
    this.save()
    this.emitFollowUps(binding)
    if (!this.busyThreads.has(threadId)) void this.deliverNextFollowUp(threadId)
    return [...binding.followUps]
  }

  updateFollowUp(threadId: string, followUpId: string, text: string): QueuedFollowUp[] {
    const binding = this.binding(threadId)
    const item = binding.followUps?.find((followUp) => followUp.id === followUpId)
    if (!item) throw new Error('Queued follow-up not found.')
    if (!text.trim() && item.attachments.length === 0) throw new Error('A follow-up message is required.')
    item.text = text
    this.save()
    this.emitFollowUps(binding)
    return [...(binding.followUps ?? [])]
  }

  removeFollowUp(threadId: string, followUpId: string): QueuedFollowUp[] {
    const binding = this.binding(threadId)
    binding.followUps = (binding.followUps ?? []).filter((item) => item.id !== followUpId)
    this.save()
    this.emitFollowUps(binding)
    return [...binding.followUps]
  }

  moveFollowUp(threadId: string, followUpId: string, toIndex: number): QueuedFollowUp[] {
    const binding = this.binding(threadId)
    const list = [...(binding.followUps ?? [])]
    const fromIndex = list.findIndex((item) => item.id === followUpId)
    if (fromIndex < 0) throw new Error('Queued follow-up not found.')
    const [item] = list.splice(fromIndex, 1)
    list.splice(Math.max(0, Math.min(toIndex, list.length)), 0, item)
    binding.followUps = list
    this.save()
    this.emitFollowUps(binding)
    return [...list]
  }

  async steerFollowUp(threadId: string, followUpId: string): Promise<QueuedFollowUp[]> {
    const binding = this.binding(threadId)
    const item = binding.followUps?.find((followUp) => followUp.id === followUpId)
    if (!item) throw new Error('Queued follow-up not found.')
    const backend = await this.ensureStarted(binding.backendId)
    if (!this.busyThreads.has(threadId)) {
      this.promoteFollowUp(binding, followUpId)
      this.save()
      this.emitFollowUps(binding)
      await this.deliverNextFollowUp(threadId)
      return [...(binding.followUps ?? [])]
    }
    if (DEFINITIONS[binding.backendId].capabilities.steering === 'native' && backend.steer) {
      try {
        await backend.steer(binding.nativeSessionId, this.followUpParts(item))
      } catch (error) {
        // The run ended between the click and this call, so there is no turn
        // left to fold the text into. The backend never took the message, so
        // dropping it here is what made it disappear: leave it queued and
        // promoted, and deliver it as the next message instead. Any other
        // failure is a real one and still reaches the user — but the follow-up
        // stays queued either way, because the backend never accepted it.
        const noTurn = error instanceof Error && /active turn|no longer/i.test(error.message)
        this.promoteFollowUp(binding, followUpId)
        this.save()
        this.emitFollowUps(binding)
        if (!noTurn) throw error
        void this.deliverNextFollowUp(threadId)
        return [...(binding.followUps ?? [])]
      }
      // Every backend, including the ones that report the steered text back.
      // Waiting for a backend to echo the message meant the user watched their
      // own words take a round trip before appearing — and when the backend
      // never recorded them, the message was gone from the queue and absent
      // from the transcript, because nothing had written it anywhere. Show it
      // now; reconcile drops this copy once the backend reports its own.
      this.echoSteeredMessage(binding, item)
      return this.removeFollowUp(threadId, followUpId)
    }
    this.promoteFollowUp(binding, followUpId)
    this.save()
    this.emitFollowUps(binding)
    this.intentionalAborts.add(threadId)
    await backend.abort(binding.nativeSessionId)
    return [...(binding.followUps ?? [])]
  }

  /** Move a steered follow-up ahead of everything not yet steered, but behind
   *  the ones already steered. Promoting to index 0 was the bug: steering a
   *  second message while the first was still waiting for its abort put the
   *  second in front, and only followUps[0] is ever delivered — so the first
   *  message sat behind it and the user watched it vanish. Steering twice now
   *  sends both, in the order they were steered. */
  private promoteFollowUp(binding: ThreadBinding, followUpId: string): void {
    const list = [...(binding.followUps ?? [])]
    const from = list.findIndex((followUp) => followUp.id === followUpId)
    if (from < 0) return
    const [item] = list.splice(from, 1)
    item.steeredAt = item.steeredAt ?? now()
    let to = 0
    while (to < list.length && list[to].steeredAt !== undefined) to += 1
    list.splice(to, 0, item)
    binding.followUps = list
  }

  private async deliverNextFollowUp(threadId: string): Promise<void> {
    if (this.followUpDeliveries.has(threadId) || this.busyThreads.has(threadId)) return
    const binding = this.bindings.get(threadId)
    const item = binding?.followUps?.[0]
    if (!binding || !item) return
    this.followUpDeliveries.add(threadId)
    try {
      await this.sendMessage(threadId, this.followUpParts(item), item.options)
      binding.followUps = (binding.followUps ?? []).filter((followUp) => followUp.id !== item.id)
      this.save()
      this.emitFollowUps(binding)
      if (!this.busyThreads.has(threadId) && binding.followUps.length) {
        queueMicrotask(() => void this.deliverNextFollowUp(threadId))
      }
    } catch (error) {
      // Busy is not a failure of the follow-up, and the item is still queued
      // because only a delivered one is filtered out above. The run that
      // refused it will announce idle, and that handler delivers the queue
      // again — so stay quiet rather than showing the user "boss:thread-busy"
      // for a message that is about to be sent.
      if (error instanceof Error && error.message.includes(THREAD_BUSY_ERROR)) return
      this.emit({
        type: 'session.error',
        properties: { sessionID: threadId, error: error instanceof Error ? error.message : String(error) },
        backendId: binding.backendId
      })
    } finally {
      this.followUpDeliveries.delete(threadId)
    }
  }

  threadForNative(backendId: BackendId, nativeThreadId: string): ThreadBusThread | undefined {
    const binding = this.bindingForNative(backendId, nativeThreadId)
    return binding ? this.threadBusInfo(binding) : undefined
  }

  /** Readable path for a project id, so a policy row can name its project.
   *  Empty when no open thread belongs to it; the thread bus then keeps the
   *  path it already recorded. */
  private projectPathFor(projectId: string): string {
    for (const binding of this.bindings.values()) {
      if (binding.projectId === projectId && binding.projectPath) return binding.projectPath
    }
    return ''
  }

  threadInfo(threadId: string): ThreadBusThread | undefined {
    const binding = this.bindings.get(threadId)
    return binding ? this.threadBusInfo(binding) : undefined
  }

  threadList(projectId: string): ThreadBusThread[] {
    return [...this.bindings.values()]
      .filter((binding) => !projectId || binding.projectId === projectId)
      .map((binding) => this.threadBusInfo(binding))
      .sort((a, b) => a.title.localeCompare(b.title))
  }

  private threadBusInfo(binding: ThreadBinding): ThreadBusThread {
    return {
      id: binding.id,
      title: binding.title || 'Untitled thread',
      backendId: binding.backendId,
      projectId: binding.projectId,
      projectPath: binding.projectPath,
      executionPath: binding.executionPath,
      busy: this.busyThreads.has(binding.id)
    }
  }

  async threadMessages(threadId: string, limit: number): Promise<MessageWithParts[]> {
    return this.messagesList(threadId, limit)
  }

  async deliverThreadMessage(threadId: string, body: string): Promise<void> {
    await this.sendMessage(threadId, [{ type: 'text', text: body }], { mode: 'ask' })
  }

  /** Put the calling thread on its own worktree, for the agent tool.
   *
   *  Returns where it landed rather than a thread, because nothing was
   *  created — this is the same conversation in a different checkout, and the
   *  agent needs to know its files moved. */
  async useWorktree(threadId: string): Promise<{ path: string; branch: string }> {
    const session = await this.moveToWorktree(threadId, true)
    const worktree = session.worktree
    if (!worktree) throw new Error('The worktree was created but could not be bound to this thread.')
    return { path: worktree.path, branch: worktree.branch }
  }

  /** Take the calling thread off its worktree, for the agent tool.
   *
   *  Removes the checkout and returns the thread to the project. Git refuses
   *  while there is uncommitted or untracked work, so nothing is lost by
   *  asking; the branch is kept either way. */
  async leaveWorktree(threadId: string): Promise<{ path: string; branch: string }> {
    const binding = this.binding(threadId)
    const worktree = binding.worktree
    if (!worktree || worktree.status !== 'active') throw new Error('This thread is not on a worktree.')
    await this.removeWorktree(worktree.id, true)
    return { path: binding.projectPath, branch: worktree.branch }
  }

  async spawnWorktreeThread(threadId: string, instruction: string, agent?: BackendId): Promise<ThreadBusThread> {
    const created = await this.forkIntoWorktree(threadId, instruction, undefined, agent)
    const info = this.threadInfo(created.id)
    if (!info) throw new Error('The worktree thread was created but could not be registered.')
    return info
  }

  private async runCommand(
    threadId: string,
    command: string,
    args: string,
    options?: BackendMessageOptions
  ): Promise<MessageWithParts> {
    const binding = this.binding(threadId)
    const backend = await this.ensureStarted(binding.backendId)
    if (!backend.runCommand) throw new Error(`${DEFINITIONS[binding.backendId].label} does not support native slash commands.`)
    const message = await backend.runCommand(binding.nativeSessionId, command, args, options)
    return {
      info: { ...message.info, sessionID: threadId },
      parts: message.parts.map((part) => ({ ...part, sessionID: threadId }))
    }
  }

  emitThreadBus(snapshot: ThreadBusSnapshot): void {
    this.emit({ type: 'thread.bus.updated', properties: { snapshot } })
  }

  async abort(threadId: string): Promise<void> {
    const binding = this.binding(threadId)
    const backend = await this.ensureStarted(binding.backendId)
    this.intentionalAborts.add(threadId)
    await backend.abort(binding.nativeSessionId)
    // A run the user stopped is waiting for nothing, so a permission or
    // question it was blocked on is no longer owed an answer. Those two kinds
    // survive everything else on purpose — they outlive a run so the ask is
    // not lost — which meant a stopped thread kept saying "Answer needed"
    // forever, with no prompt left anywhere to answer.
    this.clearThreadAttention(binding)
    // Settle the run here rather than waiting for the backend to say it
    // stopped. A backend that is interrupted may never send that event, and
    // the thread then stayed "busy" — which quietly diverted the next message
    // the user typed into the follow-up queue instead of sending it.
    if (this.busyThreads.delete(threadId)) {
      this.transcripts?.finishRun(this.transcriptSource(binding), 'completed')
      this.emit({
        type: 'session.status',
        properties: { sessionID: threadId, status: { type: 'idle' } },
        backendId: binding.backendId
      })
      this.emit({
        type: 'session.idle',
        // Stopped on purpose, so the task policy stays out of it: neither a
        // reviewer nor the fallback should answer a run the user ended.
        properties: { sessionID: threadId, stopped: true },
        backendId: binding.backendId
      })
      // Settling the run here means the idle handler never sees it: emit()
      // fans out to renderers, it does not re-enter the backend event handler
      // that normally drains the queue. Without this, a message the user typed
      // while the run was still streaming — which sendPrompt queued because the
      // thread was busy — sat in the queue until the next send or a restart,
      // and looked to the user like it had disappeared.
      void this.deliverNextFollowUp(threadId)
    }
  }

  async fork(threadId: string, messageId?: string): Promise<SessionInfo> {
    const source = this.binding(threadId)
    const backend = await this.ensureStarted(source.backendId)
    const native = await backend.fork(source.nativeSessionId, messageId)
    if (native.id === source.nativeSessionId) return this.clone(threadId, source.backendId)
    const binding = this.registerNative(source.backendId, native, 'boss', {
      kind: 'fork',
      sourceThreadId: threadId,
      sourceBackendId: source.backendId
    })
    binding.projectId = source.projectId
    binding.projectPath = source.projectPath
    binding.executionPath = source.executionPath
    binding.parentID = threadId
    this.save()
    return this.session(binding, native)
  }

  private async contextPacket(sourceThreadId: string, instruction?: string): Promise<string> {
    const source = this.binding(sourceThreadId)
    const sourceBackend = await this.ensureStarted(source.backendId)
    const messages = await sourceBackend.messagesList(source.nativeSessionId)
    const diffs = await sourceBackend.diffGet(source.nativeSessionId).catch(() => [])
    const diffSummary = diffs.slice(0, 30).map((diff) => `- ${diff.path}: ${diff.status ?? 'changed'}`).join('\n')
    return [
      '[BOSS CONTEXT HANDOFF]',
      `Source thread: ${source.title ?? sourceThreadId}`,
      `Source backend: ${source.backendId}`,
      `Project: ${source.projectId === 'global' ? 'Global chat' : source.projectPath}`,
      instruction ? `User instruction: ${instruction}` : 'Continue from this context. First summarize your understanding, then wait for or follow the user’s latest request.',
      diffSummary ? `Changed files reported by the source backend:\n${diffSummary}` : '',
      'Conversation transcript:',
      transcript(messages)
    ].filter(Boolean).join('\n\n')
  }

  async clone(threadId: string, backendId: BackendId, instruction?: string, options?: BackendMessageOptions): Promise<SessionInfo> {
    const source = this.binding(threadId)
    const packet = await this.contextPacket(threadId, instruction)
    const title = `${source.title ?? 'Untitled'} · ${DEFINITIONS[backendId].label}`
    const created = await this.sessionCreate(backendId, title, {
      kind: 'clone',
      sourceThreadId: threadId,
      sourceBackendId: source.backendId
    }, source.projectId === 'global' ? 'global' : 'current')
    await this.sendMessage(
      created.id,
      [{ type: 'text', text: packet }],
      withBackendDefaults(this.defaultModel(backendId), options, 'ask')
    )
    return created
  }

  async delegate(
    threadId: string,
    backendId: BackendId,
    instruction: string,
    placement: DelegatePlacement,
    options?: BackendMessageOptions
  ): Promise<SessionInfo> {
    const task = instruction.trim()
    if (!task) throw new Error('Describe the task to delegate.')
    const source = this.binding(threadId)
    const packet = await this.contextPacket(threadId, [
      'You are a delegated worker. Complete the task below autonomously.',
      'Keep your work scoped to the task. Report the result, relevant files, verification, and any blockers when finished.',
      `Delegated task: ${task}`
    ].join('\n'))
    const shortTask = task.replace(/\s+/g, ' ').slice(0, 56)
    const title = `Delegate · ${shortTask}${task.length > 56 ? '…' : ''}`
    let created: SessionInfo

    if (placement === 'new-worktree') {
      if (!this.worktrees) throw new Error('Git worktrees are not available.')
      if (source.projectId === 'global' || !source.projectPath) {
        throw new Error('Projectless chats cannot delegate into Git worktrees.')
      }
      const worktree = await this.worktrees.create({
        projectId: source.projectId,
        projectPath: source.projectPath,
        sourcePath: source.executionPath || source.projectPath,
        title,
        ownerThreadId: undefined
      })
      try {
        created = await this.sessionCreateInScope(
          backendId,
          { projectId: source.projectId, projectPath: source.projectPath, executionPath: worktree.path },
          title,
          { kind: 'delegate', sourceThreadId: threadId, sourceBackendId: source.backendId },
          worktree
        )
        await this.worktrees.setOwner(worktree.id, created.id)
        const binding = this.binding(created.id)
        binding.worktree = { ...worktree, ownerThreadId: created.id }
        this.save()
        created = this.session(binding)
        this.reportSetupFailure(created.id, worktree.setupError, backendId)
      } catch (error) {
        await this.worktrees.remove(worktree.id).catch(() => {})
        throw error
      }
    } else {
      created = await this.sessionCreateInScope(
        backendId,
        {
          projectId: source.projectId,
          projectPath: source.projectPath,
          executionPath: source.executionPath
        },
        title,
        { kind: 'delegate', sourceThreadId: threadId, sourceBackendId: source.backendId },
        source.worktree
      )
    }

    const fallbackMode = DEFINITIONS[backendId].modes.find((mode) => mode.id === 'auto')?.id
      ?? DEFINITIONS[backendId].modes.find((mode) => mode.id === 'accept-edits')?.id
      ?? DEFINITIONS[backendId].modes[0]?.id
    await this.sendMessage(
      created.id,
      [{ type: 'text', text: packet }],
      withBackendDefaults(this.defaultModel(backendId), options, fallbackMode)
    )
    return this.sessionGet(created.id)
  }

  /** Run one task as several competing attempts, each in its own worktree.
   *
   *  Every attempt gets the same prompt and an isolated branch, so their diffs
   *  can be compared and one kept. Isolation is not optional here: attempts
   *  edit the same files by design, and sharing a checkout would leave them
   *  overwriting each other rather than competing.
   *
   *  Workers start one at a time. `git worktree add` takes the repository index
   *  lock, so creating several at once fails on lock contention rather than
   *  running faster. The agents themselves still run concurrently once started.
   */
  async fanOut(
    threadId: string,
    task: string,
    workers: FanOutWorker[],
    options?: BackendMessageOptions
  ): Promise<SessionInfo[]> {
    const instruction = task.trim()
    if (!instruction) throw new Error('Describe the task to fan out.')
    const violation = fanOutViolation(workers)
    if (violation) throw new Error(violation)
    const source = this.binding(threadId)
    if (!this.worktrees) throw new Error('Git worktrees are not available.')
    if (source.projectId === 'global' || !source.projectPath) {
      throw new Error('Projectless chats cannot fan out, because each attempt needs its own worktree.')
    }

    const packet = await this.contextPacket(threadId, [
      'You are one of several workers attempting the same task independently.',
      'Other workers are solving it in their own branches. Do not coordinate with them.',
      'Complete the task on your own and report what you changed and how you verified it.',
      `Task: ${instruction}`
    ].join('\n'))

    const created: SessionInfo[] = []
    // Prompts go out only once every worktree that is going to exist does, so a
    // slow first agent cannot hold up the rest of the fan-out.
    const dispatch = (): Promise<unknown> => Promise.all(created.map((session, index) => {
      const backendId = workers[index].backendId
      const mode = DEFINITIONS[backendId].modes.find((entry) => entry.id === 'auto')?.id
        ?? DEFINITIONS[backendId].modes[0]?.id
      return this.sendMessage(
        session.id,
        [{ type: 'text', text: packet }],
        withBackendDefaults(this.defaultModel(backendId), options, mode)
      ).catch((error) => {
        // One agent failing to start does not invalidate the others.
        this.setThreadAttention(this.binding(session.id), 'error', this.errorDetail(error))
      })
    }))

    for (const [index, worker] of workers.entries()) {
      const title = fanOutTitle(instruction, worker, index)
      const worktree = await this.worktrees.create({
        projectId: source.projectId,
        projectPath: source.projectPath,
        sourcePath: source.executionPath || source.projectPath,
        title,
        ownerThreadId: undefined
      })
      try {
        const session = await this.sessionCreateInScope(
          worker.backendId,
          { projectId: source.projectId, projectPath: source.projectPath, executionPath: worktree.path },
          title,
          { kind: 'delegate', sourceThreadId: threadId, sourceBackendId: source.backendId },
          worktree
        )
        await this.worktrees.setOwner(worktree.id, session.id)
        const binding = this.binding(session.id)
        binding.worktree = { ...worktree, ownerThreadId: session.id }
        this.save()
        this.reportSetupFailure(session.id, worktree.setupError, worker.backendId)
        created.push(this.session(binding))
      } catch (error) {
        await this.worktrees.remove(worktree.id).catch(() => {})
        // Give the attempts that did start their task before reporting the
        // failure. They are real work in real worktrees, and leaving them idle
        // and prompt-less would be worse than the partial failure itself.
        if (!created.length) throw error
        await dispatch()
        throw new Error(
          `Started ${created.length} of ${workers.length} attempts, then failed: ${this.errorDetail(error) ?? 'unknown error'}`
        )
      }
    }

    await dispatch()
    return Promise.all(created.map((session) => this.sessionGet(session.id)))
  }

  /** Give a thread its own checkout, keeping the conversation.
   *
   *  Forking makes a new thread and hands it a summary; this moves the one you
   *  are in. The natural order is to explore on the main checkout and isolate
   *  once you know what to change, and until now that meant deciding before
   *  you knew.
   *
   *  Refuses when the thread already has one — two worktrees for one thread
   *  would leave the first orphaned with its branch. */
  async moveToWorktree(threadId: string, calledByThread = false): Promise<SessionInfo> {
    if (!this.worktrees) throw new Error('Git worktrees are not available.')
    const binding = this.binding(threadId)
    if (binding.worktree?.status === 'active') throw new Error('This thread already has its own worktree.')
    if (binding.projectId === 'global' || !binding.projectPath) throw new Error('Projectless chats cannot use Git worktrees.')
    // Not when the thread asks for itself: an agent calling this is mid-turn by
    // definition, so the check could never pass. It guards a move from outside,
    // where changing the directory under a running agent is a surprise.
    if (!calledByThread && this.busyThreads.has(threadId)) {
      throw new Error('Wait for this thread to finish before moving it to a worktree.')
    }

    const worktree = await this.worktrees.create({
      projectId: binding.projectId,
      projectPath: binding.projectPath,
      sourcePath: binding.executionPath || binding.projectPath,
      title: binding.title,
      ownerThreadId: threadId
    })
    // The binding is what binding() pushes to the backend on every lookup, so
    // setting it here is what actually moves the agent.
    binding.executionPath = worktree.path
    binding.worktree = { ...worktree, ownerThreadId: threadId }
    this.save()
    this.backends[binding.backendId]?.setSessionDirectory?.(binding.nativeSessionId, worktree.path)
    this.reportSetupFailure(threadId, worktree.setupError, binding.backendId)
    const session = this.session(binding)
    this.emit({ type: 'session.updated', properties: { info: session }, backendId: binding.backendId })
    return session
  }

  async forkIntoWorktree(
    threadId: string,
    instruction?: string,
    options?: BackendMessageOptions,
    targetBackendId?: BackendId
  ): Promise<SessionInfo> {
    if (!this.worktrees) throw new Error('Git worktrees are not available.')
    const source = this.binding(threadId)
    const backendId = targetBackendId ?? source.backendId
    if (source.projectId === 'global' || !source.projectPath) throw new Error('Projectless chats cannot create Git worktrees.')
    const worktree = await this.worktrees.create({
      projectId: source.projectId,
      projectPath: source.projectPath,
      sourcePath: source.executionPath || source.projectPath,
      title: source.title,
      ownerThreadId: undefined
    })
    let packet: string
    let created: SessionInfo
    try {
      packet = await this.contextPacket(
        threadId,
        instruction ?? `Continue this conversation in the new Git worktree on branch ${worktree.branch}.`
      )
      created = await this.sessionCreateInScope(
        backendId,
        { projectId: source.projectId, projectPath: source.projectPath, executionPath: worktree.path },
        `${source.title ?? 'Untitled'} · worktree`,
        { kind: 'fork', sourceThreadId: threadId, sourceBackendId: source.backendId },
        worktree
      )
    } catch (error) {
      await this.worktrees.remove(worktree.id).catch(() => {})
      throw error
    }
    const binding = this.binding(created.id)
    await this.worktrees.setOwner(worktree.id, created.id)
    binding.worktree = { ...worktree, ownerThreadId: created.id }
    this.save()
    // Before the first message, so it is read before the agent starts working
    // in a checkout that may not have its dependencies.
    this.reportSetupFailure(created.id, worktree.setupError, backendId)
    await this.sendMessage(
      created.id,
      [{ type: 'text', text: packet }],
      withBackendDefaults(this.defaultModel(backendId), options, 'ask')
    )
    return this.session(binding)
  }

  /** Say that a worktree's setup script failed.
   *
   *  The checkout is valid and the thread can run, so this is not a throw. But
   *  an agent about to work in a project whose dependencies were never
   *  installed should not have to discover that from a build error. */
  private reportSetupFailure(threadId: string, detail: string | undefined, backendId: BackendId): void {
    if (!detail) return
    this.emit({
      type: 'session.error',
      properties: {
        sessionID: threadId,
        error: `The project's .worktreesetup script failed in this worktree, so it may be missing dependencies. ${detail}`
      },
      backendId
    })
  }

  /** Publish a thread's todo list when the agent has just changed it.
   *
   *  Opencode has no todo event: it keeps the list behind a GET, and writes to
   *  it with a tool call like any other. Reading it when that call finishes is
   *  what makes the list fill in during a run — before this it was fetched only
   *  when the thread went idle, so it stayed empty for exactly as long as it
   *  was worth watching. Backends without todos return an empty list, and the
   *  tool name never matches, so this costs them nothing.
   *
   *  The name is read from both places it can be. Opencode sends it as the
   *  part's own `tool` field; the backends that build parts by hand put it in
   *  `state.tool`. Reading only the latter meant this never once matched a real
   *  opencode run, which is what pinned the list at its opening count. */
  private publishTodosAfterToolCall(binding: ThreadBinding, part: MessageWithParts['parts'][number]): void {
    if (!isCompletedTodoToolCall(part)) return
    const backend = this.backends[binding.backendId]
    if (!backend?.todosGet) return
    void backend.todosGet(binding.nativeSessionId)
      .then((todos) => {
        this.emit({
          type: 'todo.updated',
          properties: { sessionID: binding.id, todos },
          backendId: binding.backendId
        })
      })
      .catch(() => { /* the list is a display, not something to fail a run over */ })
  }

  private async cleanupWorktrees(): Promise<void> {
    if (!this.worktrees) return
    const result = await this.worktrees.cleanup().catch(() => undefined)
    if (!result) return
    const all = await this.worktrees.list()
    const worktrees = new Map(all.map((item) => [item.id, item]))
    let changed = false
    for (const binding of this.bindings.values()) {
      const current = binding.worktree ? worktrees.get(binding.worktree.id) : undefined
      if (current && current.status !== binding.worktree?.status) {
        const stranded = current.status === 'removed' && binding.executionPath === current.path
        binding.worktree = current
        // Reaped underneath it: bring it home rather than leaving it pointing
        // into a directory that is gone. Cleanup only takes worktrees with no
        // uncommitted work, so there is nothing here to lose.
        if (stranded) {
          binding.executionPath = binding.projectPath
          this.backends[binding.backendId]?.setSessionDirectory?.(binding.nativeSessionId, binding.projectPath)
          this.emit({
            type: 'session.updated',
            properties: { info: this.session(binding) },
            backendId: binding.backendId
          })
        }
        changed = true
      }
    }
    if (changed) this.save()
  }

  async worktreeSettings(patch?: Partial<WorktreeSettings>): Promise<WorktreeSettings> {
    if (!this.worktrees) throw new Error('Git worktrees are not available.')
    return patch ? this.worktrees.setSettings(patch) : this.worktrees.settings()
  }

  async removeWorktree(id: string, calledByOwner = false): Promise<WorktreeInfo> {
    if (!this.worktrees) throw new Error('Git worktrees are not available.')
    const owner = [...this.bindings.values()].find((binding) => binding.worktree?.id === id)
    // Not when the thread is removing its own: an agent calling this is
    // mid-turn by definition, so the check could never pass. It guards a
    // removal from outside, where pulling the directory out from under a
    // running agent is the surprise.
    if (!calledByOwner && owner && this.busyThreads.has(owner.id)) {
      throw new Error('Stop the running agent before removing its worktree.')
    }
    const removed = await this.worktrees.remove(id)
    for (const binding of this.bindings.values()) {
      if (binding.worktree?.id !== id) continue
      binding.worktree = removed
      // Back to the project. Marking the worktree removed while leaving the
      // thread pointing into it left the thread in a directory that no longer
      // exists — every command after that failed with no explanation.
      binding.executionPath = binding.projectPath
      this.backends[binding.backendId]?.setSessionDirectory?.(binding.nativeSessionId, binding.projectPath)
      this.emit({
        type: 'session.updated',
        properties: { info: this.session(binding) },
        backendId: binding.backendId
      })
    }
    this.save()
    return removed
  }

  async relay(sourceThreadId: string, targetThreadId: string, instruction?: string): Promise<SessionInfo> {
    if (sourceThreadId === targetThreadId) throw new Error('Choose a different target thread.')
    const packet = await this.contextPacket(sourceThreadId, instruction ?? 'Review this update and respond with anything the source thread should know.')
    await this.sendMessage(targetThreadId, [{ type: 'text', text: packet }], { mode: 'ask' })
    return this.sessionGet(targetThreadId)
  }

  supervisionSnapshot(): SupervisionSnapshot {
    this.load()
    const threads = [...this.bindings.values()].map((binding) => {
      const usage = this.transcripts?.usage(binding.id) ?? {
        totals: { runs: 0, durationMs: 0, tokenRuns: 0, toolCalls: 0 }
      }
      return {
        threadId: binding.id,
        backendId: binding.backendId,
        title: binding.title ?? 'Untitled thread',
        projectPath: binding.projectPath,
        executionPath: binding.executionPath,
        updatedAt: binding.updatedAt,
        worktreeBranch: binding.worktree?.branch,
        running: this.busyThreads.has(binding.id),
        attention: binding.attention,
        lastRun: usage.lastRun,
        usage: usage.totals,
        policy: binding.policy,
        archived: binding.archived === true,
        mode: binding.mode,
        // The model a client needs to send a valid options.model: a variant
        // alone is not a legal request, since providerID and modelID are
        // required alongside it.
        model: binding.model,
        parentID: binding.parentID,
        lineage: binding.lineage,
        result: binding.result,
        policyState: binding.policyState
      }
    }).sort((a, b) => b.updatedAt - a.updatedAt)
    const totals = threads.reduce<ThreadUsageTotals>((value, thread) => ({
      runs: value.runs + thread.usage.runs,
      durationMs: value.durationMs + thread.usage.durationMs,
      tokens: thread.usage.tokens === undefined ? value.tokens : (value.tokens ?? 0) + thread.usage.tokens,
      tokenRuns: value.tokenRuns + thread.usage.tokenRuns,
      toolCalls: value.toolCalls + thread.usage.toolCalls
    }), { runs: 0, durationMs: 0, tokenRuns: 0, toolCalls: 0 })
    return { generatedAt: now(), threads, totals }
  }

  acknowledgeAttention(threadId: string): SupervisionSnapshot {
    const binding = this.binding(threadId)
    if (binding.attention?.kind !== 'permission' && binding.attention?.kind !== 'question') {
      this.clearThreadAttention(binding)
    }
    return this.supervisionSnapshot()
  }

  taskPolicy(threadId: string): TaskPolicy | undefined {
    return this.binding(threadId).policy
  }

  setTaskPolicy(threadId: string, policy: TaskPolicy): TaskPolicy {
    const binding = this.binding(threadId)
    binding.policy = normalizeTaskPolicy(policy)
    this.save()
    this.emit({ type: 'thread.policy.updated', properties: { threadId, policy: binding.policy }, backendId: binding.backendId })
    return binding.policy
  }

  searchTranscripts(query: string, limit?: number): TranscriptSearchResult[] {
    this.load()
    if (!this.transcripts) return []
    return this.transcripts.search(query, limit).flatMap((result) => {
      const binding = this.bindings.get(result.threadId)
      return binding ? [{
        ...result,
        backendId: binding.backendId,
        title: binding.title ?? 'Untitled thread',
        projectPath: binding.projectPath
      }] : []
    })
  }

  async handle(request: BackendRequest): Promise<unknown> {
    if (request.type.startsWith('automation.')) {
      if (!this.automations) throw new Error('Automations are not available.')
      return this.automations.handle(request)
    }
    if (request.type.startsWith('mcp.')) {
      if (!this.mcpHub) throw new Error('MCP connections are not available.')
      return this.mcpHub.handle(request)
    }
    if (request.type.startsWith('mobile.')) {
      if (!this.mobile) throw new Error('Mobile access is not available.')
      return this.mobile.handle(request)
    }
    if (request.type.startsWith('telegram.')) {
      if (!this.telegram) throw new Error('Telegram messaging is not available.')
      return this.telegram.handle(request)
    }
    if (request.type.startsWith('remote.')) {
      if (!this.remote) throw new Error('Remote access is not available.')
      return this.remote.handle(request)
    }
    switch (request.type) {
      case 'backend.list': return this.descriptors()
      case 'backend.auth.status': return this.backendAuth?.statuses() ?? []
      case 'backend.subscription-usage': return this.backendAuth?.subscriptionUsage() ?? []
      case 'backend.defaults.set': return this.setDefaultModels(request.defaults)
      case 'lab.connections.get': return this.labConnections()
      case 'lab.connection.save': return this.saveLabConnection(request.connection)
      case 'lab.connection.delete': return this.deleteLabConnection(request.connectionId)
      case 'thread.title.settings.get': return this.titleSettings()
      case 'thread.title.settings.set': return this.titleSettings({ autoNameFromFirstPrompt: request.autoNameFromFirstPrompt })
      case 'sandbox.settings.get': return this.sandbox()
      case 'sandbox.settings.set': return this.sandbox({ networkAccess: request.networkAccess })
      case 'backend.bin.get': return this.binaryPaths()
      case 'backend.bin.set': return this.setBinaryPath(request.backendId, request.path)
      case 'backend.restart': return this.restartBackend(request.backendId)
      case 'thread.list': return this.sessionsList()
      case 'thread.create': return request.executionPath
        ? this.createScopedThread(request.backendId, this.scopeFor(request.executionPath), request.title ?? 'Untitled thread')
        : this.sessionCreate(request.backendId, request.title, undefined, request.scope)
      case 'thread.backend.set': return this.setEmptyThreadBackend(request.threadId, request.backendId)
      case 'thread.get': return this.sessionGet(request.threadId)
      case 'thread.delete': return this.sessionDelete(request.threadId)
      case 'thread.rename': return this.sessionRename(request.threadId, request.title)
      case 'thread.messages': return this.messagesList(request.threadId, request.limit)
      case 'thread.send': return this.sendMessage(request.threadId, request.parts, request.options)
      case 'thread.followups.list': return this.followUps(request.threadId)
      case 'thread.followups.add': return this.addFollowUp(request.threadId, request.text, request.attachments, request.options)
      case 'thread.followups.update': return this.updateFollowUp(request.threadId, request.followUpId, request.text)
      case 'thread.followups.remove': return this.removeFollowUp(request.threadId, request.followUpId)
      case 'thread.followups.move': return this.moveFollowUp(request.threadId, request.followUpId, request.toIndex)
      case 'thread.followups.steer': return this.steerFollowUp(request.threadId, request.followUpId)
      case 'thread.abort': return this.abort(request.threadId)
      case 'thread.mode.set': return this.setThreadMode(request.threadId, request.mode)
      case 'thread.todos': {
        const binding = this.binding(request.threadId)
        return (await this.ensureStarted(binding.backendId)).todosGet(binding.nativeSessionId)
      }
      case 'thread.permission': {
        const binding = this.binding(request.threadId)
        return (await this.ensureStarted(binding.backendId)).permissionRespond(
          binding.nativeSessionId,
          request.permissionId,
          request.response
        )
      }
      case 'thread.question': {
        const binding = this.binding(request.threadId)
        const backend = await this.ensureStarted(binding.backendId)
        if (!backend.questionRespond) throw new Error(`${binding.backendId} cannot be answered this way.`)
        return backend.questionRespond(binding.nativeSessionId, request.requestId, request.answers)
      }
      case 'thread.diff': {
        const binding = this.binding(request.threadId)
        return (await this.ensureStarted(binding.backendId)).diffGet(binding.nativeSessionId, request.messageId)
      }
      case 'thread.fork': return this.fork(request.threadId, request.messageId)
      case 'thread.revert': {
        const binding = this.binding(request.threadId)
        return (await this.ensureStarted(binding.backendId)).revert(binding.nativeSessionId, request.messageId)
      }
      case 'thread.unrevert': {
        const binding = this.binding(request.threadId)
        return (await this.ensureStarted(binding.backendId)).unrevert(binding.nativeSessionId)
      }
      case 'thread.command': return this.runCommand(request.threadId, request.command, request.arguments, request.options)
      case 'thread.compact': {
        const binding = this.binding(request.threadId)
        return (await this.ensureStarted(binding.backendId)).compact(binding.nativeSessionId, request.model)
      }
      case 'thread.models': {
        const id = request.threadId ? this.binding(request.threadId).backendId : request.backendId ?? 'opencode'
        return (await this.ensureStarted(id)).modelsList()
      }
      case 'supervision.snapshot': return this.supervisionSnapshot()
      case 'supervision.search': return this.searchTranscripts(request.query, request.limit)
      case 'supervision.acknowledge': return this.acknowledgeAttention(request.threadId)
      case 'thread.archive': {
        const binding = this.binding(request.threadId)
        binding.archived = request.archived
        this.save()
        return this.supervisionSnapshot()
      }
      case 'thread.policy.get': return this.taskPolicy(request.threadId)
      case 'thread.policy.set': return this.setTaskPolicy(request.threadId, request.policy)
      case 'thread.clone': return this.clone(request.threadId, request.backendId, request.instruction, request.options)
      case 'thread.delegate': return this.delegate(request.threadId, request.backendId, request.instruction, request.placement, request.options)
      case 'thread.fanOut': return this.fanOut(request.threadId, request.task, request.workers, request.options)
      case 'thread.worktree.create': return this.forkIntoWorktree(request.threadId, request.instruction, request.options)
      case 'worktree.list': {
        if (!this.worktrees) return []
        const projectId = request.threadId ? this.binding(request.threadId).projectId : this.currentScope.projectId
        return this.worktrees.list(projectId)
      }
      case 'worktree.settings.get': return this.worktreeSettings()
      case 'worktree.settings.set': return this.worktreeSettings({
        autoCleanupEnabled: request.autoCleanupEnabled,
        cleanupAfterDays: request.cleanupAfterDays,
        location: request.location
      })
      case 'worktree.remove': return this.removeWorktree(request.worktreeId)
      case 'thread.relay': return this.relay(request.sourceThreadId, request.targetThreadId, request.instruction)
      case 'thread.bus.get': {
        if (!this.threadBus) throw new Error('Thread collaboration is not available.')
        const binding = request.threadId ? this.binding(request.threadId) : undefined
        const scope = binding
          ? { projectId: binding.projectId, projectPath: binding.projectPath }
          : this.currentScope
        return this.threadBus.snapshot(scope.projectId, scope.projectPath)
      }
      case 'thread.bus.policy': {
        if (!this.threadBus) throw new Error('Thread collaboration is not available.')
        // A project id names its target outright. Threads run in many projects
        // at once, so the app's current project is not a safe stand-in: it
        // silently wrote the policy onto whichever project was opened last.
        if (request.projectId) {
          const known = this.projectPathFor(request.projectId)
          return this.threadBus.setPolicy(request.projectId, known, request.policy)
        }
        const binding = request.threadId ? this.binding(request.threadId) : undefined
        if (!binding) throw new Error('Choose which project this policy applies to.')
        return this.threadBus.setPolicy(binding.projectId, binding.projectPath, request.policy)
      }
      case 'thread.bus.default-policy': {
        if (!this.threadBus) throw new Error('Thread collaboration is not available.')
        const binding = request.threadId ? this.binding(request.threadId) : undefined
        const scope = binding
          ? { projectId: binding.projectId, projectPath: binding.projectPath }
          : this.currentScope
        return this.threadBus.setDefaultPolicy(scope.projectId, scope.projectPath, request.policy)
      }
      case 'thread.bus.clear-failures': {
        if (!this.threadBus) throw new Error('Thread collaboration is not available.')
        const binding = request.threadId ? this.binding(request.threadId) : undefined
        const scope = binding
          ? { projectId: binding.projectId, projectPath: binding.projectPath }
          : this.currentScope
        return this.threadBus.clearFailures(scope.projectId, scope.projectPath)
      }
      case 'thread.qa.get': {
        if (!this.threadBus) throw new Error('QA tools are not available.')
        this.binding(request.threadId)
        return this.threadBus.qaStatus(request.threadId)
      }
      case 'thread.qa.policy': {
        if (!this.threadBus) throw new Error('QA tools are not available.')
        this.binding(request.threadId)
        return this.threadBus.setQaPolicy(request.threadId, request.policy)
      }
      case 'qa.default.get': {
        if (!this.threadBus) throw new Error('QA tools are not available.')
        return this.threadBus.qaDefault()
      }
      case 'qa.default.policy': {
        if (!this.threadBus) throw new Error('QA tools are not available.')
        return this.threadBus.setQaDefault(request.policy)
      }
    }
  }
}

export { textFromParts }
