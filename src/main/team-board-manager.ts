import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { hostname, userInfo } from 'node:os'
import type { BackendId, BackendRequest } from '../shared/backend'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error Application builds use bundler resolution.
import { normalizeTaskInput, normalizeTeamUrl, planningPrompt, taskPrompt } from '../shared/team.ts'
import type {
  TeamAccessInfo,
  TeamBoard,
  TeamMember,
  TeamSnapshot,
  TeamStartTaskInput,
  TeamStartPlanningInput,
  TeamTask,
  TeamTaskExecution,
  TeamTaskInput,
  TeamTaskPatch
} from '../shared/team'
import type { TeamAgentTool } from '../shared/team'

interface TeamConnection {
  url: string
  token: string
  boardId: string
  lastError?: string
  cachedBoard?: TeamBoard
}

interface LocalTaskBinding {
  boardId: string
  taskId: string
  threadId: string
  projectPath: string
  execution: TeamTaskExecution
}

interface StoredTeamState {
  version: 1
  identity: TeamMember
  accessToken: string
  hosted?: TeamBoard
  connection?: TeamConnection
  localBindings: LocalTaskBinding[]
}

export interface TeamTaskHost {
  startTeamTask(input: {
    backendId: BackendId
    projectPath: string
    title: string
    prompt: string
    worktree: boolean
  }): Promise<{ threadId: string; worktreeBranch?: string }>
  emit(event: Record<string, unknown>): void
}

function now(): number {
  return Date.now()
}

function defaultName(): string {
  try {
    const value = userInfo().username.trim()
    return value ? value[0].toUpperCase() + value.slice(1) : 'Developer'
  } catch {
    return 'Developer'
  }
}

function newIdentity(): TeamMember {
  const timestamp = now()
  return {
    id: randomUUID(),
    name: defaultName(),
    deviceName: hostname(),
    joinedAt: timestamp,
    lastSeenAt: timestamp
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

export class TeamBoardManager {
  private readonly stateFile: string
  private readonly host: TeamTaskHost
  private loaded = false
  private state: StoredTeamState = {
    version: 1,
    identity: newIdentity(),
    accessToken: randomBytes(24).toString('base64url'),
    localBindings: []
  }

  constructor(stateFile: string, host: TeamTaskHost) {
    this.stateFile = stateFile
    this.host = host
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed = JSON.parse(readFileSync(this.stateFile, 'utf8')) as Partial<StoredTeamState>
      if (parsed.version === 1 && parsed.identity && typeof parsed.accessToken === 'string') {
        this.state = {
          version: 1,
          identity: parsed.identity,
          accessToken: parsed.accessToken,
          hosted: parsed.hosted,
          connection: parsed.connection,
          localBindings: Array.isArray(parsed.localBindings) ? parsed.localBindings : []
        }
      }
    } catch {
      /* A fresh install starts without a team board. */
    }
  }

  private save(): void {
    mkdirSync(dirname(this.stateFile), { recursive: true })
    writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2), { mode: 0o600 })
  }

  private emit(): void {
    this.host.emit({ type: 'team.updated', properties: {} })
  }

  access(): TeamAccessInfo {
    this.load()
    return { token: this.state.accessToken }
  }

  authorize(token: string): boolean {
    this.load()
    const supplied = Buffer.from(token)
    const expected = Buffer.from(this.state.accessToken)
    return supplied.length === expected.length && timingSafeEqual(supplied, expected)
  }

  private identity(actorId?: string, actorName?: string): TeamMember {
    const current = this.state.identity
    if (!actorId) return { ...current, lastSeenAt: now() }
    return {
      id: actorId,
      name: actorName?.trim().slice(0, 100) || 'Teammate',
      joinedAt: now(),
      lastSeenAt: now()
    }
  }

  private requireBoard(boardId: string): TeamBoard {
    const board = this.state.hosted
    if (!board || board.id !== boardId) throw new Error('That team board is no longer available on this host.')
    return board
  }

  private touchMember(board: TeamBoard, member: TeamMember): TeamMember {
    const existing = board.members.find((item) => item.id === member.id)
    if (existing) {
      existing.name = member.name
      existing.deviceName = member.deviceName ?? existing.deviceName
      existing.lastSeenAt = now()
      return existing
    }
    const joined = { ...member, joinedAt: now(), lastSeenAt: now() }
    board.members.push(joined)
    board.updatedAt = now()
    board.revision += 1
    return joined
  }

  private hostSnapshot(actor?: TeamMember): TeamSnapshot {
    this.load()
    const board = this.state.hosted
    if (board && actor) {
      const existing = board.members.find((member) => member.id === actor.id)
      const shouldRefresh = !existing
        || existing.name !== actor.name
        || existing.deviceName !== actor.deviceName
        || now() - existing.lastSeenAt > 15_000
      if (shouldRefresh) {
        this.touchMember(board, actor)
        this.save()
      }
    }
    return {
      mode: board ? 'host' : 'none',
      identity: clone(actor ?? this.state.identity),
      board: board ? clone(board) : undefined
    }
  }

  private async remoteRequest<T>(request: BackendRequest): Promise<T> {
    const connection = this.state.connection
    if (!connection) throw new Error('This R.A.L.F. is not connected to a team host.')
    const response = await fetch(`${connection.url}/api/request`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${connection.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(12_000)
    })
    const payload = await response.json() as { ok?: boolean; result?: T; error?: string }
    if (!response.ok || !payload.ok) throw new Error(payload.error || `Team host returned ${response.status}.`)
    return payload.result as T
  }

  private peerSnapshot(snapshot: TeamSnapshot, connected = true, error?: string): TeamSnapshot {
    const connection = this.state.connection
    if (!connection) return snapshot
    const boardChanged = Boolean(snapshot.board && snapshot.board.revision !== connection.cachedBoard?.revision)
    const connectionChanged = connection.lastError !== error
    if (snapshot.board && boardChanged) connection.cachedBoard = clone(snapshot.board)
    if (connectionChanged) connection.lastError = error
    if (boardChanged || connectionChanged) this.save()
    return {
      ...snapshot,
      mode: 'peer',
      identity: clone(this.state.identity),
      board: snapshot.board ? clone(snapshot.board) : connection.cachedBoard ? clone(connection.cachedBoard) : undefined,
      connection: { url: connection.url, connected, error }
    }
  }

  private peerRequest(request: BackendRequest): BackendRequest {
    return {
      ...request,
      viaPeer: true,
      actorId: this.state.identity.id,
      actorName: this.state.identity.name
    } as BackendRequest
  }

  private async snapshot(): Promise<TeamSnapshot> {
    this.load()
    if (!this.state.connection) return this.hostSnapshot()
    try {
      const snapshot = await this.remoteRequest<TeamSnapshot>(this.peerRequest({ type: 'team.snapshot' }))
      return this.peerSnapshot(snapshot)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return this.peerSnapshot({ mode: 'peer', identity: this.state.identity }, false, detail)
    }
  }

  private createBoard(name: string, brief?: string, memberName?: string): TeamSnapshot {
    this.load()
    if (this.state.connection) throw new Error('Disconnect from the current team before hosting another board.')
    if (memberName?.trim()) this.state.identity.name = memberName.trim().slice(0, 100)
    const boardName = name.trim().slice(0, 160)
    if (!boardName) throw new Error('A team name is required.')
    const timestamp = now()
    const host = { ...this.state.identity, joinedAt: timestamp, lastSeenAt: timestamp }
    this.state.hosted = {
      id: randomUUID(),
      name: boardName,
      brief: brief?.trim().slice(0, 20_000) ?? '',
      hostId: host.id,
      members: [host],
      tasks: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      revision: 1
    }
    this.save()
    this.emit()
    return this.hostSnapshot()
  }

  private boardUpdate(request: Extract<BackendRequest, { type: 'team.board.update' }>): TeamSnapshot {
    const board = this.requireBoard(request.boardId)
    this.touchMember(board, this.identity(request.actorId, request.actorName))
    if (request.name !== undefined) {
      const name = request.name.trim().slice(0, 160)
      if (!name) throw new Error('A team name is required.')
      board.name = name
    }
    if (request.brief !== undefined) board.brief = request.brief.trim().slice(0, 20_000)
    board.updatedAt = now()
    board.revision += 1
    this.save()
    this.emit()
    return this.hostSnapshot()
  }

  private createTask(boardId: string, input: TeamTaskInput, actor: TeamMember): TeamSnapshot {
    const board = this.requireBoard(boardId)
    this.touchMember(board, actor)
    const normalized = normalizeTaskInput(input)
    const timestamp = now()
    board.tasks.push({
      id: randomUUID(),
      title: normalized.title,
      summary: normalized.summary ?? '',
      acceptanceCriteria: normalized.acceptanceCriteria ?? [],
      status: normalized.status ?? 'proposed',
      projectHint: normalized.projectHint,
      dependencies: normalized.dependencies ?? [],
      updates: [],
      createdById: actor.id,
      createdByName: actor.name,
      createdAt: timestamp,
      updatedAt: timestamp,
      revision: 1
    })
    board.updatedAt = timestamp
    board.revision += 1
    this.save()
    this.emit()
    return this.hostSnapshot()
  }

  private patchTask(task: TeamTask, patch: TeamTaskPatch, actor: TeamMember): void {
    if (patch.title !== undefined) {
      const title = patch.title.trim().slice(0, 180)
      if (!title) throw new Error('A task title is required.')
      task.title = title
    }
    if (patch.summary !== undefined) task.summary = patch.summary.trim().slice(0, 8_000)
    if (patch.acceptanceCriteria !== undefined) {
      task.acceptanceCriteria = patch.acceptanceCriteria.map((item) => item.trim()).filter(Boolean).slice(0, 30)
    }
    if (patch.projectHint !== undefined) task.projectHint = patch.projectHint.trim().slice(0, 500) || undefined
    if (patch.dependencies !== undefined) task.dependencies = patch.dependencies.filter((id) => id !== task.id).slice(0, 30)
    if (patch.status !== undefined) task.status = patch.status
    if (patch.assigneeId !== undefined) task.assigneeId = patch.assigneeId ?? undefined
    if (patch.assigneeName !== undefined) task.assigneeName = patch.assigneeName ?? undefined
    if (patch.execution !== undefined) task.execution = patch.execution ?? undefined
    const publicUpdate = patch.publicUpdate?.trim().slice(0, 4_000)
    if (publicUpdate) {
      task.updates.push({ id: randomUUID(), authorId: actor.id, authorName: actor.name, body: publicUpdate, createdAt: now() })
      task.updates = task.updates.slice(-100)
    }
    task.updatedAt = now()
    task.revision += 1
  }

  private taskUpdate(request: Extract<BackendRequest, { type: 'team.task.update' }>): TeamSnapshot {
    const board = this.requireBoard(request.boardId)
    const actor = this.touchMember(board, this.identity(request.actorId, request.actorName))
    const task = board.tasks.find((item) => item.id === request.taskId)
    if (!task) throw new Error('That task no longer exists.')
    if (request.expectedRevision !== undefined && task.revision !== request.expectedRevision) {
      throw new Error('This task changed on another R.A.L.F. Refresh it before saving your changes.')
    }
    this.patchTask(task, request.patch, actor)
    board.updatedAt = now()
    board.revision += 1
    this.save()
    this.emit()
    return this.hostSnapshot()
  }

  private claimTask(request: Extract<BackendRequest, { type: 'team.task.claim' }>): TeamSnapshot {
    const board = this.requireBoard(request.boardId)
    const actor = this.touchMember(board, this.identity(request.actorId, request.actorName))
    const task = board.tasks.find((item) => item.id === request.taskId)
    if (!task) throw new Error('That task no longer exists.')
    if (request.release) {
      if (task.assigneeId && task.assigneeId !== actor.id && board.hostId !== actor.id) {
        throw new Error(`${task.assigneeName ?? 'Another teammate'} currently owns this task.`)
      }
      task.assigneeId = undefined
      task.assigneeName = undefined
      task.execution = undefined
      task.status = 'ready'
    } else {
      if (task.assigneeId && task.assigneeId !== actor.id) {
        throw new Error(`${task.assigneeName ?? 'Another teammate'} already claimed this task.`)
      }
      task.assigneeId = actor.id
      task.assigneeName = actor.name
      if (task.status === 'proposed' || task.status === 'ready') task.status = 'claimed'
    }
    task.updatedAt = now()
    task.revision += 1
    board.updatedAt = now()
    board.revision += 1
    this.save()
    this.emit()
    return this.hostSnapshot()
  }

  private deleteTask(request: Extract<BackendRequest, { type: 'team.task.delete' }>): TeamSnapshot {
    const board = this.requireBoard(request.boardId)
    this.touchMember(board, this.identity(request.actorId, request.actorName))
    const task = board.tasks.find((item) => item.id === request.taskId)
    if (!task) return this.hostSnapshot()
    if (task.execution?.state === 'running') throw new Error('Stop or finish the active agent before removing this task.')
    board.tasks = board.tasks.filter((item) => item.id !== request.taskId)
    for (const item of board.tasks) item.dependencies = item.dependencies.filter((id) => id !== request.taskId)
    board.updatedAt = now()
    board.revision += 1
    this.save()
    this.emit()
    return this.hostSnapshot()
  }

  private async proxyMutation(request: BackendRequest): Promise<TeamSnapshot> {
    return this.peerSnapshot(await this.remoteRequest<TeamSnapshot>(this.peerRequest(request)))
  }

  private async startTask(input: TeamStartTaskInput): Promise<{ snapshot: TeamSnapshot; threadId: string }> {
    const snapshot = await this.snapshot()
    const board = snapshot.board
    if (!board || board.id !== input.boardId) throw new Error('That team board is not available.')
    const task = board.tasks.find((item) => item.id === input.taskId)
    if (!task) throw new Error('That task no longer exists.')
    const identity = this.state.identity
    if (task.assigneeId && task.assigneeId !== identity.id) throw new Error(`${task.assigneeName ?? 'Another teammate'} owns this task.`)
    if (!task.assigneeId) {
      await this.handle({ type: 'team.task.claim', boardId: board.id, taskId: task.id })
    }
    const startedAt = now()
    const started = await this.host.startTeamTask({
      backendId: input.backendId,
      projectPath: input.projectPath,
      title: task.title,
      prompt: taskPrompt(board, task),
      worktree: input.worktree
    })
    const execution: TeamTaskExecution = {
      memberId: identity.id,
      memberName: identity.name,
      backendId: input.backendId,
      worktreeBranch: started.worktreeBranch,
      state: 'running',
      startedAt,
      updatedAt: now()
    }
    this.state.localBindings = this.state.localBindings.filter((item) => item.taskId !== task.id)
    this.state.localBindings.push({ boardId: board.id, taskId: task.id, threadId: started.threadId, projectPath: input.projectPath, execution })
    this.save()
    const next = await this.handle({
      type: 'team.task.update',
      boardId: board.id,
      taskId: task.id,
      patch: { status: 'working', assigneeId: identity.id, assigneeName: identity.name, execution }
    }) as TeamSnapshot
    return { snapshot: next, threadId: started.threadId }
  }

  private async startPlanning(input: TeamStartPlanningInput): Promise<{ snapshot: TeamSnapshot; threadId: string }> {
    const state = await this.snapshot()
    const board = state.board
    if (!board || board.id !== input.boardId) throw new Error('That team board is not available.')
    const started = await this.host.startTeamTask({
      backendId: input.backendId,
      projectPath: input.projectPath,
      title: `Plan · ${board.name}`,
      prompt: planningPrompt(board),
      worktree: false
    })
    return { snapshot: state, threadId: started.threadId }
  }

  async handleBackendEvent(event: Record<string, unknown>): Promise<void> {
    this.load()
    const properties = (event.properties ?? {}) as { sessionID?: string }
    const threadId = properties.sessionID
    if (!threadId) return
    const binding = this.state.localBindings.find((item) => item.threadId === threadId)
    if (!binding) return
    let state = binding.execution.state
    if (event.type === 'session.status') {
      const status = (properties as { status?: { type?: string } }).status?.type
      state = status === 'busy' || status === 'retry' ? 'running' : 'waiting'
    } else if (event.type === 'session.idle') state = 'waiting'
    else if (event.type === 'permission.asked' || event.type === 'question.asked') state = 'needs-attention'
    else if (event.type === 'session.error') state = 'stopped'
    else return
    if (state === binding.execution.state) return
    binding.execution = { ...binding.execution, state, updatedAt: now() }
    this.save()
    await this.handle({
      type: 'team.task.update',
      boardId: binding.boardId,
      taskId: binding.taskId,
      patch: { execution: binding.execution }
    }).catch(() => {})
  }

  async agentCall(threadId: string, tool: TeamAgentTool, args: unknown): Promise<unknown> {
    this.load()
    if (tool === 'ralf_team_board_read') {
      const state = await this.snapshot()
      if (!state.board) throw new Error('This R.A.L.F. is not connected to a team board.')
      const binding = this.state.localBindings.find((item) => item.threadId === threadId && item.boardId === state.board?.id)
      return { board: state.board, currentTaskId: binding?.taskId }
    }
    if (tool === 'ralf_team_tasks_propose') {
      const state = await this.snapshot()
      if (!state.board) throw new Error('This R.A.L.F. is not connected to a team board.')
      const tasks = args && typeof args === 'object' ? (args as { tasks?: unknown }).tasks : undefined
      if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('Pass at least one proposed task.')
      if (tasks.length > 20) throw new Error('Propose at most 20 tasks at a time.')
      let result = state
      for (const item of tasks) {
        if (!item || typeof item !== 'object') throw new Error('Each proposed task must be an object.')
        const value = item as { title?: unknown; summary?: unknown; acceptanceCriteria?: unknown; projectHint?: unknown }
        result = await this.handle({
          type: 'team.task.create',
          boardId: state.board.id,
          input: {
            title: typeof value.title === 'string' ? value.title : '',
            summary: typeof value.summary === 'string' ? value.summary : undefined,
            acceptanceCriteria: Array.isArray(value.acceptanceCriteria)
              ? value.acceptanceCriteria.filter((criterion): criterion is string => typeof criterion === 'string')
              : undefined,
            projectHint: typeof value.projectHint === 'string' ? value.projectHint : undefined,
            status: 'proposed'
          }
        }) as TeamSnapshot
      }
      return result.board
    }
    if (tool === 'ralf_team_task_publish') {
      const binding = this.state.localBindings.find((item) => item.threadId === threadId)
      if (!binding) throw new Error('This thread was not started from a team task.')
      const input = args && typeof args === 'object' ? args as { update?: unknown; status?: unknown } : {}
      const update = typeof input.update === 'string' ? input.update.trim() : ''
      const allowedStatuses = new Set(['working', 'blocked', 'review', 'done'])
      const status = typeof input.status === 'string' && allowedStatuses.has(input.status)
        ? input.status as Extract<TeamTask['status'], 'working' | 'blocked' | 'review' | 'done'>
        : undefined
      if (!update && !status) throw new Error('Publish an update, a status, or both.')
      const result = await this.handle({
        type: 'team.task.update',
        boardId: binding.boardId,
        taskId: binding.taskId,
        patch: { publicUpdate: update || undefined, status }
      }) as TeamSnapshot
      return result.board?.tasks.find((task) => task.id === binding.taskId)
    }
    throw new Error('Unknown R.A.L.F. team tool.')
  }

  async handle(request: BackendRequest): Promise<unknown> {
    this.load()
    const isPeer = Boolean(this.state.connection && !('viaPeer' in request && request.viaPeer))
    switch (request.type) {
      case 'team.snapshot':
        return request.viaPeer ? this.hostSnapshot(this.identity(request.actorId, request.actorName)) : this.snapshot()
      case 'team.access': return this.access()
      case 'team.identity.set': {
        const name = request.name.trim().slice(0, 100)
        if (!name) throw new Error('A display name is required.')
        this.state.identity.name = name
        if (this.state.hosted) this.touchMember(this.state.hosted, this.state.identity)
        this.save()
        this.emit()
        return this.snapshot()
      }
      case 'team.create': return this.createBoard(request.name, request.brief, request.memberName)
      case 'team.close': {
        if (this.state.connection) throw new Error('Disconnect from the remote team instead.')
        this.state.hosted = undefined
        this.state.localBindings = []
        this.state.accessToken = randomBytes(24).toString('base64url')
        this.save()
        this.emit()
        return this.hostSnapshot()
      }
      case 'team.connect': {
        const url = normalizeTeamUrl(request.url)
        const name = request.memberName.trim().slice(0, 100)
        if (!name) throw new Error('A display name is required.')
        this.state.identity.name = name
        const response = await fetch(`${url}/api/request`, {
          method: 'POST',
          headers: { authorization: `Bearer ${request.token.trim()}`, 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'team.peer.join', member: this.state.identity, viaPeer: true } satisfies BackendRequest),
          signal: AbortSignal.timeout(12_000)
        })
        const payload = await response.json() as { ok?: boolean; result?: TeamSnapshot; error?: string }
        if (!response.ok || !payload.ok || !payload.result?.board) throw new Error(payload.error || 'The team host did not accept this connection.')
        this.state.connection = { url, token: request.token.trim(), boardId: payload.result.board.id, cachedBoard: clone(payload.result.board) }
        this.save()
        this.emit()
        return this.peerSnapshot(payload.result)
      }
      case 'team.disconnect': {
        this.state.connection = undefined
        this.state.localBindings = []
        this.save()
        this.emit()
        return this.hostSnapshot()
      }
      case 'team.peer.join': {
        if (!request.viaPeer) throw new Error('Invalid peer join request.')
        const board = this.state.hosted
        if (!board) throw new Error('This R.A.L.F. is not hosting a team board.')
        this.touchMember(board, request.member)
        this.save()
        this.emit()
        return this.hostSnapshot(request.member)
      }
      case 'team.board.update':
        return isPeer ? this.proxyMutation(request) : this.boardUpdate(request)
      case 'team.task.create':
        return isPeer
          ? this.proxyMutation(request)
          : this.createTask(request.boardId, request.input, this.identity(request.actorId, request.actorName))
      case 'team.task.update':
        return isPeer ? this.proxyMutation(request) : this.taskUpdate(request)
      case 'team.task.delete':
        return isPeer ? this.proxyMutation(request) : this.deleteTask(request)
      case 'team.task.claim':
        return isPeer ? this.proxyMutation(request) : this.claimTask(request)
      case 'team.task.start': return this.startTask(request.input)
      case 'team.plan.start': return this.startPlanning(request.input)
      default: throw new Error(`Unsupported team request: ${request.type}`)
    }
  }
}
