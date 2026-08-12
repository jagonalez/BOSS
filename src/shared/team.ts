import type { BackendId } from './backend'

export type TeamTaskStatus = 'proposed' | 'ready' | 'claimed' | 'working' | 'blocked' | 'review' | 'done'
export type TeamExecutionState = 'starting' | 'running' | 'waiting' | 'needs-attention' | 'stopped'
export type TeamAgentTool = 'ralf_team_board_read' | 'ralf_team_tasks_propose' | 'ralf_team_task_publish'

export interface TeamMember {
  id: string
  name: string
  deviceName?: string
  joinedAt: number
  lastSeenAt: number
}

export interface TeamTaskUpdate {
  id: string
  authorId: string
  authorName: string
  body: string
  createdAt: number
}

export interface TeamTaskExecution {
  memberId: string
  memberName: string
  backendId: BackendId
  worktreeBranch?: string
  state: TeamExecutionState
  startedAt: number
  updatedAt: number
}

export interface TeamTask {
  id: string
  title: string
  summary: string
  acceptanceCriteria: string[]
  status: TeamTaskStatus
  assigneeId?: string
  assigneeName?: string
  projectHint?: string
  dependencies: string[]
  updates: TeamTaskUpdate[]
  execution?: TeamTaskExecution
  createdById: string
  createdByName: string
  createdAt: number
  updatedAt: number
  revision: number
}

export interface TeamBoard {
  id: string
  name: string
  brief: string
  hostId: string
  members: TeamMember[]
  tasks: TeamTask[]
  createdAt: number
  updatedAt: number
  revision: number
}

export interface TeamConnectionView {
  url: string
  connected: boolean
  error?: string
}

export interface TeamSnapshot {
  mode: 'none' | 'host' | 'peer'
  identity: TeamMember
  board?: TeamBoard
  connection?: TeamConnectionView
}

export interface TeamTaskInput {
  title: string
  summary?: string
  acceptanceCriteria?: string[]
  projectHint?: string
  dependencies?: string[]
  status?: Extract<TeamTaskStatus, 'proposed' | 'ready'>
}

export interface TeamTaskPatch {
  title?: string
  summary?: string
  acceptanceCriteria?: string[]
  projectHint?: string
  dependencies?: string[]
  status?: TeamTaskStatus
  assigneeId?: string | null
  assigneeName?: string | null
  publicUpdate?: string
  execution?: TeamTaskExecution | null
}

export interface TeamStartTaskInput {
  boardId: string
  taskId: string
  backendId: BackendId
  projectPath: string
  worktree: boolean
}

export interface TeamStartPlanningInput {
  boardId: string
  backendId: BackendId
  projectPath: string
}

export interface TeamAccessInfo {
  token: string
}

export const TEAM_TASK_STATUSES: TeamTaskStatus[] = [
  'proposed',
  'ready',
  'claimed',
  'working',
  'blocked',
  'review',
  'done'
]

export const TEAM_AGENT_TOOL_DEFINITIONS = [
  {
    name: 'ralf_team_board_read' as const,
    description: 'Read the shared R.A.L.F. team brief, people, tasks, and public updates. Private agent transcripts are never included.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    readOnly: true
  },
  {
    name: 'ralf_team_tasks_propose' as const,
    description: 'Propose structured tasks on the connected R.A.L.F. team board for people to discuss and claim.',
    inputSchema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              summary: { type: 'string' },
              acceptanceCriteria: { type: 'array', items: { type: 'string' } },
              projectHint: { type: 'string' }
            },
            required: ['title'],
            additionalProperties: false
          }
        }
      },
      required: ['tasks'],
      additionalProperties: false
    },
    readOnly: false
  },
  {
    name: 'ralf_team_task_publish' as const,
    description: 'Publish a concise team-visible update or status for the team task that started this thread. Never publishes the private transcript.',
    inputSchema: {
      type: 'object',
      properties: {
        update: { type: 'string', description: 'Concise result, blocker, decision, or handoff to share.' },
        status: { type: 'string', enum: ['working', 'blocked', 'review', 'done'] }
      },
      additionalProperties: false
    },
    readOnly: false
  }
] as const

export function normalizeTeamUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(trimmed)) throw new Error('Enter the HTTP or HTTPS address shared by the team host.')
  return trimmed
}

export function normalizeTaskInput(input: TeamTaskInput): TeamTaskInput {
  const title = input.title.trim().slice(0, 180)
  if (!title) throw new Error('A task title is required.')
  return {
    title,
    summary: input.summary?.trim().slice(0, 8_000) ?? '',
    acceptanceCriteria: (input.acceptanceCriteria ?? []).map((item) => item.trim()).filter(Boolean).slice(0, 30),
    projectHint: input.projectHint?.trim().slice(0, 500) || undefined,
    dependencies: (input.dependencies ?? []).filter(Boolean).slice(0, 30),
    status: input.status === 'ready' ? 'ready' : 'proposed'
  }
}

export function taskPrompt(board: TeamBoard, task: TeamTask): string {
  const dependencyTitles = task.dependencies
    .map((id) => board.tasks.find((item) => item.id === id)?.title)
    .filter(Boolean)
  return [
    '[R.A.L.F. TEAM TASK]',
    `Team: ${board.name}`,
    board.brief ? `Shared brief:\n${board.brief}` : '',
    `Task: ${task.title}`,
    task.summary ? `Details:\n${task.summary}` : '',
    task.acceptanceCriteria.length
      ? `Acceptance criteria:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join('\n')}`
      : '',
    dependencyTitles.length ? `Related dependencies:\n${dependencyTitles.map((item) => `- ${item}`).join('\n')}` : '',
    'Work with the developer to complete this task. Keep changes scoped to the task. The private conversation stays on this machine; only updates the developer explicitly publishes are shared with the team.'
  ].filter(Boolean).join('\n\n')
}

export function planningPrompt(board: TeamBoard): string {
  return [
    '[R.A.L.F. TEAM PLANNING]',
    `Team: ${board.name}`,
    board.brief ? `Shared brief:\n${board.brief}` : 'The shared brief is currently empty. Ask the developer for the intended outcome and constraints.',
    'Help the developer turn this brief into a small, coherent set of independently claimable tasks. Read the current board with ralf_team_board_read, discuss assumptions and sequencing, then use ralf_team_tasks_propose only when the developer agrees with the proposed breakdown. Do not assign tasks or start work. Private planning conversation stays on this machine; only the task cards you explicitly propose are shared.'
  ].join('\n\n')
}
