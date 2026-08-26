import { app } from 'electron'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BACKEND_IDS, isBackendId, type BackendId } from '@shared/backend'
import type { MessageWithParts } from '@shared/opencode'
import { QA_GUIDANCE, QA_TOOL_DEFINITIONS, isAgentToolResult, type QaAgentTool, type QaPolicy } from '@shared/qa'
import type {
  CollaborationPolicy,
  ThreadBusAgentTool,
  ThreadBusConnection,
  ThreadBusMessage,
  ThreadBusSnapshot,
  ThreadBusThread
} from '@shared/thread-bus'
import { THREAD_TOOL_DESCRIPTIONS } from '@shared/thread-bus'
import { REPORT_TOOL_DESCRIPTIONS, WORKFLOW_TOOL_DESCRIPTIONS } from '@shared/thread-bus'
import type { Workflow, WorkflowInput, WorkflowRun, WorkflowTrigger, WorkflowsSnapshot } from '@shared/workflow'
import { policyOverrides, policySource, resolvePolicy } from '@shared/collaboration-policy'
import { projectScope } from './project-identity'

import type { QaTools } from './qa-tools'
import { MCP_TOOL_PREFIX } from '@shared/mcp'
import type { McpHub } from './mcp-hub'
import type { ReviewManager } from './review-manager'
import type { ReportManager } from './report-manager'
/** What the bus needs from the workflow engine, kept structural so the bus
 *  has no import-time dependency on the engine class. */
interface WorkflowEngineHandle {
  snapshot(): WorkflowsSnapshot
  create(input: WorkflowInput, source: Workflow['source'], options?: { enabled?: boolean }): Promise<Workflow>
  update(id: string, patch: Partial<WorkflowInput> & { enabled?: boolean }): Promise<Workflow>
  runNow(workflowId: string, event?: undefined, options?: { startedByThreadId?: string }): Promise<WorkflowRun>
}


interface LegacyThreadBusState {
  version: 1
  policies: Record<string, CollaborationPolicy>
  messages: Array<Omit<ThreadBusMessage, 'projectId'>>
}

interface LegacyProjectPolicyState {
  version: 2
  policies: Record<string, CollaborationPolicy>
  messages: ThreadBusMessage[]
}

interface StoredThreadBusState {
  version: 3
  /** Applied to every project without an entry in `policies`. */
  defaultPolicy: CollaborationPolicy
  policies: Record<string, CollaborationPolicy>
  projectPaths: Record<string, string>
  messages: ThreadBusMessage[]
}

export interface ThreadBusHost {
  threadForNative(backendId: BackendId, nativeThreadId: string): ThreadBusThread | undefined
  threadInfo(threadId: string): ThreadBusThread | undefined
  threadList(projectId: string): ThreadBusThread[]
  threadMessages(threadId: string, limit: number): Promise<MessageWithParts[]>
  deliverThreadMessage(threadId: string, body: string): Promise<void>
  spawnWorktreeThread(threadId: string, instruction: string, agent?: BackendId): Promise<ThreadBusThread>
  useWorktree(threadId: string): Promise<{ path: string; branch: string }>
  leaveWorktree(threadId: string): Promise<{ path: string; branch: string }>
  emitThreadBus(snapshot: ThreadBusSnapshot): void
}

const MAX_MESSAGES = 500
const MAX_BODY = 16_000
const MAX_QUEUE_PER_THREAD = 25

function stateFile(): string {
  return join(app.getPath('userData'), 'thread-bus.json')
}

function messageText(messages: MessageWithParts[]): string {
  return messages.map((message) => {
    const text = message.parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .filter(Boolean)
      .join('\n')
    return text ? `${message.info.role === 'user' ? 'USER' : 'ASSISTANT'}:\n${text}` : ''
  }).filter(Boolean).join('\n\n').slice(-24_000)
}

function stringArg(value: unknown, key: string): string {
  if (!value || typeof value !== 'object') return ''
  const result = (value as Record<string, unknown>)[key]
  return typeof result === 'string' ? result.trim() : ''
}

function numberArg(value: unknown, key: string, fallback: number): number {
  if (!value || typeof value !== 'object') return fallback
  const result = Number((value as Record<string, unknown>)[key])
  return Number.isFinite(result) ? result : fallback
}

function booleanArg(value: unknown, key: string, fallback: boolean): boolean {
  if (!value || typeof value !== 'object') return fallback
  const result = (value as Record<string, unknown>)[key]
  return typeof result === 'boolean' ? result : fallback
}

export class ThreadBus {
  private readonly policies: Record<string, CollaborationPolicy> = {}
  /** Last known path per overridden project, so settings can name a project
   *  the user has not opened in this session. */
  private readonly projectPaths: Record<string, string> = {}
  private defaultPolicy: CollaborationPolicy = 'off'
  private messages: ThreadBusMessage[] = []
  private server: Server | null = null
  private token = ''
  private port = 0
  private readonly deliveryLocks = new Set<string>()
  private qaTools?: QaTools
  private mcpHub?: McpHub
  private reviews?: ReviewManager
  private reports?: ReportManager
  private workflowEngine?: WorkflowEngineHandle

  constructor(private readonly host: ThreadBusHost) {
    this.load()
  }

  attachQaTools(qaTools: QaTools): void {
    this.qaTools = qaTools
  }

  attachMcpHub(mcpHub: McpHub): void {
    this.mcpHub = mcpHub
  }

  attachReviews(reviews: ReviewManager): void {
    this.reviews = reviews
  }

  attachReports(reports: ReportManager): void {
    this.reports = reports
  }

  attachWorkflowEngine(engine: WorkflowEngineHandle): void {
    this.workflowEngine = engine
  }

  qaStatus(threadId: string) {
    if (!this.qaTools) throw new Error('QA tools are not available.')
    return this.qaTools.status(threadId)
  }

  setQaPolicy(threadId: string, policy: QaPolicy | null) {
    if (!this.qaTools) throw new Error('QA tools are not available.')
    return this.qaTools.setPolicy(threadId, policy)
  }

  qaDefault(): QaPolicy {
    if (!this.qaTools) throw new Error('QA tools are not available.')
    return this.qaTools.default()
  }

  setQaDefault(policy: QaPolicy) {
    if (!this.qaTools) throw new Error('QA tools are not available.')
    return this.qaTools.setDefault(policy)
  }

  private load(): void {
    try {
      const state = JSON.parse(readFileSync(stateFile(), 'utf8')) as StoredThreadBusState | LegacyProjectPolicyState | LegacyThreadBusState
      if (state.version === 3) {
        this.defaultPolicy = state.defaultPolicy ?? 'off'
        Object.assign(this.policies, state.policies)
        Object.assign(this.projectPaths, state.projectPaths)
        this.messages = Array.isArray(state.messages) ? state.messages.slice(-MAX_MESSAGES) : []
        return
      }
      if (state.version === 2) {
        // Version 2 had no default, so every project fell back to 'off'.
        // Keeping the default at 'off' preserves each project's effective
        // policy across the upgrade.
        Object.assign(this.policies, state.policies)
        this.messages = Array.isArray(state.messages) ? state.messages.slice(-MAX_MESSAGES) : []
        // Version 2 kept no paths, so recover what the messages remember. An
        // overridden project with no message stays unnamed until it is next
        // set, which the settings list handles.
        for (const message of this.messages) {
          if (message.projectId && message.projectPath) this.projectPaths[message.projectId] = message.projectPath
        }
        this.save()
        return
      }
      if (state.version === 1) {
        for (const [path, policy] of Object.entries(state.policies)) {
          const scope = projectScope(path)
          this.policies[scope.projectId] = policy
          if (scope.projectPath) this.projectPaths[scope.projectId] = scope.projectPath
        }
        this.messages = Array.isArray(state.messages)
          ? state.messages.slice(-MAX_MESSAGES).map((message) => {
            const scope = projectScope(message.projectPath)
            return { ...message, projectId: scope.projectId, projectPath: scope.projectPath }
          })
          : []
        this.save()
      }
    } catch {
      /* First launch starts with collaboration disabled. */
    }
  }

  private save(): void {
    const state: StoredThreadBusState = {
      version: 3,
      defaultPolicy: this.defaultPolicy,
      policies: this.policies,
      projectPaths: this.projectPaths,
      messages: this.messages.slice(-MAX_MESSAGES)
    }
    try {
      writeFileSync(stateFile(), JSON.stringify(state, null, 2))
    } catch {
      /* The in-memory broker remains usable if persistence is unavailable. */
    }
  }

  policy(projectId: string): CollaborationPolicy {
    return resolvePolicy(this.policies, this.defaultPolicy, projectId)
  }

  /** Set the policy for one project. Passing null drops the override, so the
   *  project follows the default again. */
  setPolicy(projectId: string, projectPath: string, policy: CollaborationPolicy | null): ThreadBusSnapshot {
    if (policy === null) {
      delete this.policies[projectId]
      delete this.projectPaths[projectId]
    } else {
      this.policies[projectId] = policy
      // Recorded so the settings list can name an overridden project the user
      // has not opened in this session.
      if (projectPath) this.projectPaths[projectId] = projectPath
    }
    this.save()
    return this.publish(projectId, projectPath || this.projectPaths[projectId] || '')
  }

  setDefaultPolicy(projectId: string, projectPath: string, policy: CollaborationPolicy): ThreadBusSnapshot {
    this.defaultPolicy = policy
    this.save()
    return this.publish(projectId, projectPath)
  }

  clearFailures(projectId: string, projectPath: string): ThreadBusSnapshot {
    this.messages = this.messages.filter((message) => message.status !== 'failed' || message.projectId !== projectId)
    this.save()
    return this.publish(projectId, projectPath)
  }

  snapshot(projectId: string, projectPath: string): ThreadBusSnapshot {
    const messages = this.messages.filter((message) => message.projectId === projectId).slice(-100)
    return {
      projectId,
      projectPath,
      policy: this.policy(projectId),
      defaultPolicy: this.defaultPolicy,
      source: policySource(this.policies, projectId),
      overrides: policyOverrides(this.policies, this.projectPaths),
      threads: this.host.threadList(projectId),
      messages,
      toolBackends: ['opencode', 'pi', 'codex', 'claude']
    }
  }

  private publish(projectId: string, projectPath: string): ThreadBusSnapshot {
    const snapshot = this.snapshot(projectId, projectPath)
    this.host.emitThreadBus(snapshot)
    return snapshot
  }

  async agentCall(backendId: BackendId, nativeThreadId: string, tool: ThreadBusAgentTool, args: unknown): Promise<unknown> {
    const caller = this.host.threadForNative(backendId, nativeThreadId)
    if (!caller) throw new Error('BOSS could not identify the calling thread.')
    const result = await this.runAgentCall(caller.id, tool, args)
    // Do not publish an image as a separate transcript message here. Every
    // backend returns the image with its completed tool result, where it has a
    // real message id. Eager publication happens before that id exists, which
    // used to create an ownerless assistant-tool-image message and then show
    // the same screenshot again after every streamed assistant update.
    return result
  }

  private async runAgentCall(callerId: string, tool: ThreadBusAgentTool, args: unknown): Promise<unknown> {
    const caller = this.host.threadInfo(callerId)
    if (!caller) throw new Error('BOSS could not identify the calling thread.')
    if (tool.startsWith('boss_browser_') || tool === 'boss_computer') {
      if (!this.qaTools) throw new Error('BOSS QA tools are not ready.')
      return this.qaTools.call(caller.id, tool as QaAgentTool, args)
    }
    if (tool.startsWith(MCP_TOOL_PREFIX) || tool === 'boss_mcp_list' || tool === 'boss_mcp_call') {
      if (!this.mcpHub) throw new Error('BOSS MCP connections are not ready.')
      if (tool === 'boss_mcp_list') return this.mcpHub.agentListing(stringArg(args, 'tool') || undefined)
      if (tool === 'boss_mcp_call') {
        const name = stringArg(args, 'tool')
        if (!name) throw new Error('Pass the tool name from boss_mcp_list.')
        const argumentsJson = stringArg(args, 'argumentsJson')
        const inline = (args as Record<string, unknown> | undefined)?.arguments
        let toolArgs: unknown = inline && typeof inline === 'object' ? inline : {}
        if (argumentsJson) {
          try {
            toolArgs = JSON.parse(argumentsJson)
          } catch {
            throw new Error('argumentsJson must be a valid JSON object.')
          }
        }
        return this.mcpHub.callAgentTool(name, toolArgs)
      }
      return this.mcpHub.callAgentTool(tool, args)
    }
    // Opening a change request acts on the caller's own checkout rather than reaching another
    // thread, so it is answered before the collaboration policy, which governs that reach.
    if (tool === 'boss_git_create_change_request') {
      if (!this.reviews) throw new Error('Review providers are not available.')
      const title = stringArg(args, 'title')
      const body = stringArg(args, 'body')
      const baseBranch = stringArg(args, 'baseBranch')
      return this.reviews.createChangeRequest(caller.executionPath, {
        ...(title ? { title } : {}),
        ...(body ? { body } : {}),
        ...(baseBranch ? { baseBranch } : {}),
        ...(booleanArg(args, 'draft', false) ? { draft: true } : {})
      })
    }
    // Report artifacts are local to BOSS and belong to the calling thread, so
    // creating or refining one does not depend on cross-thread collaboration.
    if (tool === 'boss_reports_create') {
      if (!this.reports) throw new Error('Reports are not available.')
      const report = await this.reports.createFromAgent({
        threadId: caller.id,
        projectPath: caller.projectPath,
        backendId: caller.backendId,
        title: stringArg(args, 'title'),
        summary: stringArg(args, 'summary') || undefined,
        body: stringArg(args, 'body')
      })
      return { id: report.id, title: report.title, summary: report.summary }
    }
    if (tool === 'boss_reports_update') {
      if (!this.reports) throw new Error('Reports are not available.')
      const values = args && typeof args === 'object' ? args as Record<string, unknown> : {}
      const patch = {
        ...('title' in values ? { title: typeof values.title === 'string' ? values.title : '' } : {}),
        ...('summary' in values ? { summary: typeof values.summary === 'string' ? values.summary : '' } : {}),
        ...('body' in values ? { body: typeof values.body === 'string' ? values.body : '' } : {})
      }
      if (!Object.keys(patch).length) throw new Error('Pass at least one report field to update.')
      const report = await this.reports.updateFromAgent(caller.id, stringArg(args, 'reportId'), patch)
      return { id: report.id, title: report.title, summary: report.summary, updatedAt: report.updatedAt }
    }
    // Workflows are local to BOSS and scoped to the caller's project, so like
    // reports they are answered before the collaboration policy.
    if (tool.startsWith('boss_workflow_')) {
      if (!this.workflowEngine) throw new Error('Workflows are not available.')
      return this.runWorkflowTool(caller, tool, args)
    }
    const policy = this.policy(caller.projectId)
    if (policy === 'off') throw new Error('Thread collaboration is disabled for this project.')
    if (!['boss_threads_list', 'boss_threads_read', 'boss_threads_send', 'boss_threads_reply', 'boss_threads_spawn_worktree', 'boss_threads_use_worktree', 'boss_threads_leave_worktree'].includes(tool)) {
      throw new Error('Unknown BOSS thread tool.')
    }

    switch (tool) {
      case 'boss_threads_list':
        return this.host.threadList(caller.projectId)
          .filter((thread) => thread.backendId === caller.backendId)
          .map((thread) => ({ id: thread.id, title: thread.title, busy: thread.busy, current: thread.id === caller.id }))
      case 'boss_threads_read': {
        const targetId = stringArg(args, 'threadId')
        const target = this.requirePeer(caller, targetId)
        const limit = Math.max(1, Math.min(20, numberArg(args, 'limit', 8)))
        const messages = await this.host.threadMessages(target.id, limit)
        return {
          thread: { id: target.id, title: target.title, busy: target.busy },
          transcript: messageText(messages) || '(No messages yet.)'
        }
      }
      case 'boss_threads_send':
        if (policy !== 'collaborate') throw new Error('This project allows reading threads, but not sending messages.')
        return this.send(caller, stringArg(args, 'threadId'), stringArg(args, 'message'), {
          expectsReply: booleanArg(args, 'expectsReply', true),
          maxTurns: numberArg(args, 'maxTurns', 4)
        })
      case 'boss_threads_reply': {
        if (policy !== 'collaborate') throw new Error('This project allows reading threads, but not sending replies.')
        const replyTo = this.messages.find((message) => message.id === stringArg(args, 'messageId'))
        if (!replyTo || replyTo.toThreadId !== caller.id) throw new Error('That message is not addressed to this thread.')
        if (replyTo.hopCount + 1 >= replyTo.maxTurns) throw new Error('This conversation reached its configured turn limit.')
        if (this.messages.some((message) => message.replyTo === replyTo.id && message.fromThreadId === caller.id)) {
          throw new Error('This thread already replied to that message.')
        }
        return this.send(caller, replyTo.fromThreadId, stringArg(args, 'message'), {
          expectsReply: booleanArg(args, 'expectsReply', false),
          maxTurns: replyTo.maxTurns,
          replyTo: replyTo.id,
          rootId: replyTo.rootId,
          hopCount: replyTo.hopCount + 1
        })
      }
      case 'boss_threads_spawn_worktree': {
        if (policy !== 'collaborate') throw new Error('This project does not allow agents to create worktree threads.')
        const instruction = stringArg(args, 'instruction')
        const requestedAgent = stringArg(args, 'agent')
        if (!instruction) throw new Error('An implementation instruction is required.')
        if (instruction.length > MAX_BODY) throw new Error(`Instructions are limited to ${MAX_BODY.toLocaleString()} characters.`)
        let agent: BackendId | undefined
        if (requestedAgent) {
          if (!isBackendId(requestedAgent)) throw new Error(`Agent must be one of: ${BACKEND_IDS.join(', ')}.`)
          agent = requestedAgent
        }
        return this.host.spawnWorktreeThread(caller.id, instruction, agent)
      }
      case 'boss_threads_leave_worktree':
        return this.host.leaveWorktree(caller.id)
      case 'boss_threads_use_worktree': {
        // No policy check: this isolates the caller rather than reaching
        // another thread, so it is the one thread tool that takes nothing away
        // from anyone else.
        return this.host.useWorktree(caller.id)
      }
    }
  }

  private async runWorkflowTool(caller: ThreadBusThread, tool: ThreadBusAgentTool, args: unknown): Promise<unknown> {
    const engine = this.workflowEngine!
    const values = args && typeof args === 'object' ? (args as Record<string, unknown>) : {}
    // A thread sees its own project's workflows plus global ones.
    const visible = (workflow: Workflow): boolean => workflow.projectPath === caller.projectPath || workflow.projectPath === ''
    const snapshot = engine.snapshot()
    switch (tool) {
      case 'boss_workflow_list':
        return snapshot.workflows.filter(visible).map((workflow) => {
          const latest = snapshot.runs
            .filter((run) => run.workflowId === workflow.id)
            .sort((a, b) => b.startedAt - a.startedAt)[0]
          return {
            id: workflow.id,
            name: workflow.name,
            description: workflow.description ?? '',
            enabled: workflow.enabled,
            source: workflow.source,
            triggers: workflow.triggers,
            ...(latest ? { lastRun: { id: latest.id, status: latest.status, startedAt: latest.startedAt, error: latest.error } } : {})
          }
        })
      case 'boss_workflow_create': {
        const autoApprove = snapshot.approvalMode === 'auto'
        const workflow = await engine.create(this.workflowInputFrom(caller, values), 'agent', { enabled: autoApprove })
        return {
          id: workflow.id,
          enabled: autoApprove,
          note: autoApprove
            ? 'Workflow approval is set to auto, so its triggers are live immediately. Use boss_workflow_run to also execute it once now.'
            : 'Created disabled: triggers stay dormant until the user enables it in the Workflows page. Use boss_workflow_run to execute it once now.'
        }
      }
      case 'boss_workflow_update': {
        const target = this.requireWorkflow(snapshot, stringArg(args, 'workflowId'), visible)
        const autoApprove = snapshot.approvalMode === 'auto'
        const patch: Partial<WorkflowInput> & { enabled?: boolean } = autoApprove ? {} : { enabled: false }
        if (typeof values.name === 'string' && values.name.trim()) patch.name = values.name.trim()
        if (typeof values.description === 'string') patch.description = values.description
        if (typeof values.script === 'string' && values.script.trim()) patch.script = values.script
        if ('cron' in values || 'eventType' in values || 'eventFilters' in values) {
          patch.triggers = this.workflowTriggersFrom(values)
        }
        const updated = await engine.update(target.id, patch)
        return {
          id: updated.id,
          enabled: updated.enabled,
          note: autoApprove ? 'Saved.' : 'Saved, and disabled until the user re-enables it.'
        }
      }
      case 'boss_workflow_run': {
        const target = this.requireWorkflow(snapshot, stringArg(args, 'workflowId'), visible)
        const run = await engine.runNow(target.id, undefined, { startedByThreadId: caller.id })
        return { runId: run.id, status: run.status, note: 'The result will arrive in this conversation as a message when the run finishes.' }
      }
      case 'boss_workflow_runs': {
        const workflowId = stringArg(args, 'workflowId')
        const ids = workflowId
          ? [this.requireWorkflow(snapshot, workflowId, visible).id]
          : snapshot.workflows.filter(visible).map((workflow) => workflow.id)
        const limit = Math.max(1, Math.min(20, numberArg(args, 'limit', 5)))
        return snapshot.runs
          .filter((run) => ids.includes(run.workflowId))
          .sort((a, b) => b.startedAt - a.startedAt)
          .slice(0, limit)
          .map((run) => ({
            id: run.id,
            workflowId: run.workflowId,
            status: run.status,
            trigger: run.trigger,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
            error: run.error,
            result: run.result,
            note: run.note,
            steps: run.journal.map((entry) => ({
              seq: entry.seq,
              op: entry.op,
              label: entry.label,
              status: entry.status,
              ...(entry.error ? { error: entry.error } : {})
            }))
          }))
      }
      default:
        throw new Error('Unknown BOSS workflow tool.')
    }
  }

  private requireWorkflow(snapshot: WorkflowsSnapshot, id: string, visible: (workflow: Workflow) => boolean): Workflow {
    if (!id) throw new Error('A workflow id is required.')
    const workflow = snapshot.workflows.find((item) => item.id === id)
    if (!workflow || !visible(workflow)) throw new Error('Workflow not found in this project.')
    return workflow
  }

  private workflowInputFrom(caller: ThreadBusThread, values: Record<string, unknown>): WorkflowInput {
    const name = typeof values.name === 'string' ? values.name : ''
    const script = typeof values.script === 'string' ? values.script : ''
    return {
      name,
      script,
      ...(typeof values.description === 'string' && values.description ? { description: values.description } : {}),
      projectPath: caller.projectPath,
      triggers: this.workflowTriggersFrom(values),
      overlapPolicy: 'skip'
    }
  }

  private workflowTriggersFrom(values: Record<string, unknown>): WorkflowTrigger[] {
    const triggers: WorkflowTrigger[] = []
    const cron = typeof values.cron === 'string' ? values.cron.trim() : ''
    if (cron) triggers.push({ kind: 'cron', expression: cron })
    const eventType = typeof values.eventType === 'string' ? values.eventType.trim() : ''
    if (eventType) {
      const raw = values.eventFilters && typeof values.eventFilters === 'object' && !Array.isArray(values.eventFilters)
        ? (values.eventFilters as Record<string, unknown>)
        : {}
      const filters = Object.fromEntries(
        Object.entries(raw).filter((entry): entry is [string, string | number | boolean] =>
          ['string', 'number', 'boolean'].includes(typeof entry[1])
        )
      )
      triggers.push({ kind: 'event', pattern: { type: eventType, ...(Object.keys(filters).length ? { filters } : {}) } })
    }
    return triggers
  }

  private requirePeer(caller: ThreadBusThread, targetId: string): ThreadBusThread {
    if (!targetId) throw new Error('A target thread id is required.')
    if (caller.id === targetId) throw new Error('Choose a different thread.')
    const target = this.host.threadInfo(targetId)
    if (!target) throw new Error('Target thread not found.')
    if (target.backendId !== caller.backendId) throw new Error('Agent communication is limited to threads on the same backend.')
    if (target.projectId !== caller.projectId) throw new Error('Agent communication is limited to threads in the same project.')
    return target
  }

  private async send(
    caller: ThreadBusThread,
    targetId: string,
    body: string,
    options: { expectsReply: boolean; maxTurns: number; replyTo?: string; rootId?: string; hopCount?: number }
  ): Promise<ThreadBusMessage> {
    const target = this.requirePeer(caller, targetId)
    if (!body) throw new Error('A message is required.')
    if (body.length > MAX_BODY) throw new Error(`Messages are limited to ${MAX_BODY.toLocaleString()} characters.`)
    const queued = this.messages.filter((message) => message.toThreadId === target.id && message.status === 'queued')
    if (queued.length >= MAX_QUEUE_PER_THREAD) throw new Error('The target thread queue is full.')
    const maxTurns = Math.max(1, Math.min(8, Math.round(options.maxTurns)))
    const id = randomUUID()
    const message: ThreadBusMessage = {
      id,
      rootId: options.rootId ?? id,
      fromThreadId: caller.id,
      toThreadId: target.id,
      backendId: caller.backendId,
      projectId: caller.projectId,
      projectPath: caller.projectPath,
      body,
      createdAt: Date.now(),
      status: 'queued',
      replyTo: options.replyTo,
      expectsReply: options.expectsReply,
      hopCount: options.hopCount ?? 0,
      maxTurns
    }
    this.messages.push(message)
    this.save()
    this.publish(caller.projectId, caller.projectPath)
    if (!target.busy && !this.deliveryLocks.has(target.id)) await this.deliver(message)
    return message
  }

  private prompt(message: ThreadBusMessage): string {
    const source = this.host.threadInfo(message.fromThreadId)
    return [
      '[BOSS THREAD MESSAGE]',
      `From: ${source?.title ?? message.fromThreadId} (${message.fromThreadId})`,
      `Message id: ${message.id}`,
      `Conversation turn: ${message.hopCount + 1} of ${message.maxTurns}`,
      message.body,
      message.expectsReply
        ? 'A reply was requested. Use boss_threads_reply with this message id; do not simulate a reply in another thread.'
        : 'No reply is required. Reply only if it materially helps the sending thread.'
    ].join('\n\n')
  }

  private async deliver(message: ThreadBusMessage): Promise<void> {
    this.deliveryLocks.add(message.toThreadId)
    try {
      await this.host.deliverThreadMessage(message.toThreadId, this.prompt(message))
      message.status = 'delivered'
      message.deliveredAt = Date.now()
      delete message.error
    } catch (error) {
      message.status = 'failed'
      message.error = error instanceof Error ? error.message : String(error)
      this.deliveryLocks.delete(message.toThreadId)
    }
    this.save()
    this.publish(message.projectId, message.projectPath)
  }

  async flush(threadId: string): Promise<void> {
    this.deliveryLocks.delete(threadId)
    const message = this.messages.find((item) => item.toThreadId === threadId && item.status === 'queued')
    const target = this.host.threadInfo(threadId)
    if (message && target && !target.busy) await this.deliver(message)
  }

  async resume(): Promise<void> {
    const targets = [...new Set(this.messages.filter((message) => message.status === 'queued').map((message) => message.toThreadId))]
    for (const threadId of targets) await this.flush(threadId)
  }

  private callerToken(backendId: BackendId, nativeThreadId: string): string {
    return createHmac('sha256', this.token).update(`${backendId}\0${nativeThreadId}`).digest('hex')
  }

  private authorized(request: IncomingMessage, backendId?: BackendId, nativeThreadId?: string): boolean {
    const authorization = request.headers.authorization
    if (authorization === `Bearer ${this.token}`) return true
    if (!backendId || !nativeThreadId || typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return false
    const supplied = Buffer.from(authorization.slice(7))
    const expected = Buffer.from(this.callerToken(backendId, nativeThreadId))
    return supplied.length === expected.length && timingSafeEqual(supplied, expected)
  }

  private localOrigin(request: IncomingMessage): boolean {
    const origin = request.headers.origin
    if (!origin) return true
    try {
      const hostname = new URL(origin).hostname
      return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
    } catch {
      return false
    }
  }

  private async requestBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolveBody, reject) => {
      let body = ''
      let tooLarge = false
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => {
        body += chunk
        if (body.length > 64_000) tooLarge = true
      })
      request.on('end', () => tooLarge ? reject(new Error('Thread-bus request is too large.')) : resolveBody(body))
      request.on('error', reject)
    })
  }

  private json(response: ServerResponse, status: number, value?: unknown): void {
    if (value === undefined) {
      response.writeHead(status).end()
      return
    }
    response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
  }

  private async handleAgentCall(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST') {
      this.json(response, 404)
      return
    }
    try {
      const input = JSON.parse(await this.requestBody(request)) as { backendId?: BackendId; nativeThreadId?: string; tool?: ThreadBusAgentTool; arguments?: unknown }
      if (!input.backendId || !input.nativeThreadId || !input.tool) throw new Error('Invalid thread-bus request.')
      if (!this.authorized(request, input.backendId, input.nativeThreadId)) {
        this.json(response, 404)
        return
      }
      const result = await this.agentCall(input.backendId, input.nativeThreadId, input.tool, input.arguments)
      this.json(response, 200, { ok: true, result })
    } catch (error) {
      this.json(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  private mcpTools(): Array<Record<string, unknown>> {
    const threadId = { type: 'string', description: 'BOSS thread id returned by boss_threads_list.' }
    const message = { type: 'string', description: 'Message to send to the other agent.' }
    return [
      {
        name: 'boss_threads_list',
        description: THREAD_TOOL_DESCRIPTIONS.list,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true }
      },
      {
        name: 'boss_threads_read',
        description: THREAD_TOOL_DESCRIPTIONS.read,
        inputSchema: {
          type: 'object',
          properties: { threadId, limit: { type: 'integer', minimum: 1, maximum: 20, default: 8 } },
          required: ['threadId'],
          additionalProperties: false
        },
        annotations: { readOnlyHint: true }
      },
      {
        name: 'boss_threads_send',
        description: THREAD_TOOL_DESCRIPTIONS.send,
        inputSchema: {
          type: 'object',
          properties: {
            threadId,
            message,
            expectsReply: { type: 'boolean', default: true },
            maxTurns: { type: 'integer', minimum: 1, maximum: 8, default: 4 }
          },
          required: ['threadId', 'message'],
          additionalProperties: false
        }
      },
      {
        name: 'boss_threads_reply',
        description: THREAD_TOOL_DESCRIPTIONS.reply,
        inputSchema: {
          type: 'object',
          properties: {
            messageId: { type: 'string', description: 'Message id from the incoming BOSS thread message.' },
            message,
            expectsReply: { type: 'boolean', default: false }
          },
          required: ['messageId', 'message'],
          additionalProperties: false
        }
      },
      {
        name: 'boss_threads_spawn_worktree',
        description: THREAD_TOOL_DESCRIPTIONS.spawnWorktree,
        inputSchema: {
          type: 'object',
          properties: {
            instruction: { type: 'string', description: THREAD_TOOL_DESCRIPTIONS.spawnWorktreeInstruction },
            agent: {
              type: 'string',
              enum: [...BACKEND_IDS],
              description: THREAD_TOOL_DESCRIPTIONS.spawnWorktreeAgent
            }
          },
          required: ['instruction'],
          additionalProperties: false
        }
      },
      {
        name: 'boss_threads_use_worktree',
        description: THREAD_TOOL_DESCRIPTIONS.useWorktree,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
      },
      {
        name: 'boss_threads_leave_worktree',
        description: THREAD_TOOL_DESCRIPTIONS.leaveWorktree,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
      },
      {
        name: 'boss_git_create_change_request',
        description: THREAD_TOOL_DESCRIPTIONS.createChangeRequest,
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: THREAD_TOOL_DESCRIPTIONS.createChangeRequestTitle },
            body: { type: 'string', description: THREAD_TOOL_DESCRIPTIONS.createChangeRequestBody },
            baseBranch: { type: 'string', description: THREAD_TOOL_DESCRIPTIONS.createChangeRequestBase },
            draft: { type: 'boolean', description: THREAD_TOOL_DESCRIPTIONS.createChangeRequestDraft }
          },
          additionalProperties: false
        }
      },
      {
        name: 'boss_reports_create',
        description: REPORT_TOOL_DESCRIPTIONS.create,
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: REPORT_TOOL_DESCRIPTIONS.title },
            summary: { type: 'string', description: REPORT_TOOL_DESCRIPTIONS.summary },
            body: { type: 'string', description: REPORT_TOOL_DESCRIPTIONS.body }
          },
          required: ['title', 'body'],
          additionalProperties: false
        }
      },
      {
        name: 'boss_reports_update',
        description: REPORT_TOOL_DESCRIPTIONS.update,
        inputSchema: {
          type: 'object',
          properties: {
            reportId: { type: 'string', description: REPORT_TOOL_DESCRIPTIONS.reportId },
            title: { type: 'string', description: REPORT_TOOL_DESCRIPTIONS.title },
            summary: { type: 'string', description: REPORT_TOOL_DESCRIPTIONS.summary },
            body: { type: 'string', description: REPORT_TOOL_DESCRIPTIONS.body }
          },
          required: ['reportId'],
          additionalProperties: false
        }
      },
      {
        name: 'boss_workflow_list',
        description: WORKFLOW_TOOL_DESCRIPTIONS.list,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true }
      },
      {
        name: 'boss_workflow_create',
        description: WORKFLOW_TOOL_DESCRIPTIONS.create,
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: WORKFLOW_TOOL_DESCRIPTIONS.name },
            description: { type: 'string', description: WORKFLOW_TOOL_DESCRIPTIONS.description },
            script: { type: 'string', description: WORKFLOW_TOOL_DESCRIPTIONS.script },
            cron: { type: 'string', description: WORKFLOW_TOOL_DESCRIPTIONS.cron },
            eventType: { type: 'string', description: WORKFLOW_TOOL_DESCRIPTIONS.eventType },
            eventFilters: { type: 'object', description: WORKFLOW_TOOL_DESCRIPTIONS.eventFilters }
          },
          required: ['name', 'script'],
          additionalProperties: false
        }
      },
      {
        name: 'boss_workflow_update',
        description: WORKFLOW_TOOL_DESCRIPTIONS.update,
        inputSchema: {
          type: 'object',
          properties: {
            workflowId: { type: 'string', description: WORKFLOW_TOOL_DESCRIPTIONS.workflowId },
            name: { type: 'string', description: WORKFLOW_TOOL_DESCRIPTIONS.name },
            description: { type: 'string', description: WORKFLOW_TOOL_DESCRIPTIONS.description },
            script: { type: 'string', description: WORKFLOW_TOOL_DESCRIPTIONS.script },
            cron: { type: 'string', description: WORKFLOW_TOOL_DESCRIPTIONS.cron },
            eventType: { type: 'string', description: WORKFLOW_TOOL_DESCRIPTIONS.eventType },
            eventFilters: { type: 'object', description: WORKFLOW_TOOL_DESCRIPTIONS.eventFilters }
          },
          required: ['workflowId'],
          additionalProperties: false
        }
      },
      {
        name: 'boss_workflow_run',
        description: WORKFLOW_TOOL_DESCRIPTIONS.run,
        inputSchema: {
          type: 'object',
          properties: { workflowId: { type: 'string', description: WORKFLOW_TOOL_DESCRIPTIONS.workflowId } },
          required: ['workflowId'],
          additionalProperties: false
        }
      },
      {
        name: 'boss_workflow_runs',
        description: WORKFLOW_TOOL_DESCRIPTIONS.runs,
        inputSchema: {
          type: 'object',
          properties: {
            workflowId: { type: 'string', description: WORKFLOW_TOOL_DESCRIPTIONS.workflowId },
            limit: { type: 'integer', minimum: 1, maximum: 20, default: 5, description: WORKFLOW_TOOL_DESCRIPTIONS.limit }
          },
          additionalProperties: false
        },
        annotations: { readOnlyHint: true }
      },
      ...QA_TOOL_DEFINITIONS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: tool.readOnly }
      })),
      ...(this.mcpHub?.agentToolDefinitions() ?? [])
    ]
  }

  private async handleMcp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const nativeThreadId = request.headers['x-boss-thread']
    const backendId = request.headers['x-boss-backend']
    if (backendId !== 'claude' || typeof nativeThreadId !== 'string' || !this.authorized(request, 'claude', nativeThreadId)) {
      this.json(response, 404)
      return
    }
    if (!this.localOrigin(request)) {
      this.json(response, 403)
      return
    }
    if (request.method === 'GET' || request.method === 'DELETE') {
      response.writeHead(405, { allow: 'POST' }).end()
      return
    }
    if (request.method !== 'POST') {
      this.json(response, 404)
      return
    }
    let input: { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }
    try {
      input = JSON.parse(await this.requestBody(request)) as typeof input
    } catch (error) {
      this.json(response, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: error instanceof Error ? error.message : 'Invalid JSON.' } })
      return
    }
    if (input.jsonrpc !== '2.0' || !input.method) {
      this.json(response, 400, { jsonrpc: '2.0', id: input.id ?? null, error: { code: -32600, message: 'Invalid JSON-RPC request.' } })
      return
    }
    if (input.id === undefined) {
      this.json(response, 202)
      return
    }

    const reply = (result: unknown): void => this.json(response, 200, { jsonrpc: '2.0', id: input.id, result })
    if (input.method === 'initialize') {
      const requested = typeof input.params?.protocolVersion === 'string' ? input.params.protocolVersion : ''
      const hubInstructions = this.mcpHub?.instructionsSummary()
      reply({
        protocolVersion: requested === '2025-03-26' ? requested : '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'boss-agent-tools', version: '1.0.0' },
        instructions: hubInstructions ? `${QA_GUIDANCE}\n\n${hubInstructions}` : QA_GUIDANCE
      })
      return
    }
    if (input.method === 'tools/list') {
      reply({ tools: this.mcpTools() })
      return
    }
    if (input.method === 'tools/call') {
      const name = input.params?.name
      if (typeof name !== 'string') {
        reply({ content: [{ type: 'text', text: 'BOSS could not identify the calling Claude thread.' }], isError: true })
        return
      }
      try {
        const result = await this.agentCall('claude', nativeThreadId, name as ThreadBusAgentTool, input.params?.arguments)
        if (isAgentToolResult(result)) {
          reply({
            content: [
              { type: 'text', text: result.text },
              ...(result.image ? [{ type: 'image', mimeType: result.image.mimeType, data: result.image.data }] : [])
            ],
            isError: false
          })
        } else {
          reply({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: false })
        }
      } catch (error) {
        reply({ content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true })
      }
      return
    }
    this.json(response, 200, { jsonrpc: '2.0', id: input.id, error: { code: -32601, message: 'Method not found.' } })
  }

  private connection(): ThreadBusConnection {
    return {
      url: `http://127.0.0.1:${this.port}`,
      token: this.token,
      tokenFor: (backendId, nativeThreadId) => this.callerToken(backendId, nativeThreadId),
      agentToolNames: () => (this.mcpHub?.agentToolDefinitions() ?? []).map((definition) => definition.name)
    }
  }

  async start(): Promise<ThreadBusConnection> {
    if (this.server) return this.connection()
    this.token = randomBytes(32).toString('hex')
    this.server = createServer((request, response) => {
      if (request.url === '/agent-call') {
        void this.handleAgentCall(request, response)
        return
      }
      if (request.url === '/mcp') {
        void this.handleMcp(request, response)
        return
      }
      response.writeHead(404).end()
    })
    await new Promise<void>((resolveStart, reject) => {
      this.server?.once('error', reject)
      this.server?.listen(0, '127.0.0.1', () => {
        const address = this.server?.address()
        this.port = typeof address === 'object' && address ? address.port : 0
        resolveStart()
      })
    })
    return this.connection()
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (server) await new Promise<void>((resolveStop) => server.close(() => resolveStop()))
  }
}
