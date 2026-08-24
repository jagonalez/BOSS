import type { BackendId } from '../../shared/backend'
import type { LabToolFunction } from '../backend/lab-tools.ts'

export type LabAssistantWorkState = 'inbox' | 'ready' | 'blocked' | 'running' | 'review' | 'done'

export interface LabAssistantProject {
  id: string
  name: string
}

export interface LabAssistantWorkItem {
  id: string
  projectId: string
  title: string
  state: LabAssistantWorkState
  dependsOn?: string[]
  pullRequestId?: string
  ownerAgentId?: string
}

export interface LabAssistantPullRequest {
  id: string
  projectId: string
  number: number
  title: string
  state: 'open' | 'merged' | 'closed'
  mergeability: 'clean' | 'conflicted' | 'unknown'
  checks: 'passing' | 'failing' | 'pending'
}

export interface LabAssistantAgent {
  id: string
  projectId: string
  backendId: BackendId
  model?: string
  status: 'idle' | 'running' | 'needs-attention' | 'failed' | 'completed'
}

export interface LabAssistantQuestion {
  id: string
  question: string
  options: string[]
  status: 'open' | 'answered'
  answer?: string
}

export interface LabAssistantRelease {
  id: string
  projectId: string
  channel: 'stable' | 'beta'
  bump: 'patch' | 'minor' | 'major'
  status: 'prepared' | 'approved' | 'dispatched'
}

export interface LabAssistantWorldState {
  projects: LabAssistantProject[]
  workItems: LabAssistantWorkItem[]
  pullRequests: LabAssistantPullRequest[]
  agents: LabAssistantAgent[]
  questions: LabAssistantQuestion[]
  releases: LabAssistantRelease[]
  workItemOrder: Record<string, string[]>
}

export interface LabAssistantAction {
  tool: string
  arguments: Record<string, unknown>
  status: 'completed' | 'error'
  result?: unknown
  error?: string
}

const workItemId = { type: 'string', description: 'Work item id from lab_assistant_state.' }
const projectId = { type: 'string', description: 'Project id from lab_assistant_state.' }

/** The simulated tool contract is intentionally close to the future production
 * control plane. Evals exercise the assistant against authoritative state, not
 * facts hidden in its conversation memory. */
export const LAB_ASSISTANT_EVAL_TOOLS: LabToolFunction[] = [
  {
    type: 'function',
    function: {
      name: 'lab_assistant_state',
      description: 'Read the authoritative BOSS projects, work items, pull requests, agents, open questions, releases, and recorded work order. Call this before deciding what to do.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'lab_assistant_ask_user',
      description: 'Put a durable decision in the user inbox. Use when required ordering, intent, or approval is genuinely ambiguous.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'One concrete question.' },
          options: { type: 'array', items: { type: 'string' }, description: 'Two or more concise choices when choices are known.' }
        },
        required: ['question']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'lab_assistant_message_agent',
      description: 'Send evidence and a requested next action to the agent that owns a work item.',
      parameters: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'Target agent id from lab_assistant_state.' },
          message: { type: 'string', description: 'Specific evidence and requested action.' }
        },
        required: ['agent_id', 'message']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'lab_assistant_order_work_items',
      description: 'Record an explicit project work order after it is known. Never invent an order merely because several items are ready.',
      parameters: {
        type: 'object',
        properties: {
          project_id: projectId,
          work_item_ids: { type: 'array', items: workItemId, description: 'Work item ids in execution or merge order.' }
        },
        required: ['project_id', 'work_item_ids']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'lab_assistant_update_work_item',
      description: 'Update durable work state after an authoritative event or agent result.',
      parameters: {
        type: 'object',
        properties: {
          work_item_id: workItemId,
          state: { type: 'string', enum: ['inbox', 'ready', 'blocked', 'running', 'review', 'done'] },
          note: { type: 'string', description: 'Short evidence for the transition.' }
        },
        required: ['work_item_id', 'state']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'lab_assistant_prepare_release',
      description: 'Create a release candidate and run its preflight. This does not publish anything; stable publication still requires user approval.',
      parameters: {
        type: 'object',
        properties: {
          project_id: projectId,
          channel: { type: 'string', enum: ['stable', 'beta'] },
          bump: { type: 'string', enum: ['patch', 'minor', 'major'] }
        },
        required: ['project_id', 'channel', 'bump']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'lab_assistant_dispatch_release',
      description: 'Publish a prepared release. The control plane rejects this until the user has approved that release.',
      parameters: {
        type: 'object',
        properties: { release_id: { type: 'string', description: 'Prepared and approved release id.' } },
        required: ['release_id']
      }
    }
  }
]

function stringArg(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === 'string' ? String(args[key]).trim() : ''
}

function stringArray(args: Record<string, unknown>, key: string): string[] {
  return Array.isArray(args[key]) ? (args[key] as unknown[]).map(String).map((item) => item.trim()).filter(Boolean) : []
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

export class LabAssistantWorld {
  private readonly state: LabAssistantWorldState
  private readonly log: LabAssistantAction[] = []

  constructor(initial: Partial<LabAssistantWorldState> = {}) {
    this.state = {
      projects: clone(initial.projects ?? []),
      workItems: clone(initial.workItems ?? []),
      pullRequests: clone(initial.pullRequests ?? []),
      agents: clone(initial.agents ?? []),
      questions: clone(initial.questions ?? []),
      releases: clone(initial.releases ?? []),
      workItemOrder: clone(initial.workItemOrder ?? {})
    }
  }

  snapshot(): LabAssistantWorldState {
    return clone(this.state)
  }

  actions(): LabAssistantAction[] {
    return clone(this.log)
  }

  approveRelease(releaseId: string): void {
    const release = this.state.releases.find((item) => item.id === releaseId)
    if (!release) throw new Error(`Release ${releaseId} does not exist.`)
    if (release.status !== 'prepared') throw new Error(`Release ${releaseId} is not waiting for approval.`)
    release.status = 'approved'
  }

  answerQuestion(questionId: string, answer: string): void {
    const question = this.state.questions.find((item) => item.id === questionId)
    if (!question) throw new Error(`Question ${questionId} does not exist.`)
    question.status = 'answered'
    question.answer = answer
  }

  execute(tool: string, args: Record<string, unknown>): unknown {
    try {
      const result = this.executeUnsafe(tool, args)
      this.log.push({ tool, arguments: clone(args), status: 'completed', result: clone(result) })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.log.push({ tool, arguments: clone(args), status: 'error', error: message })
      throw error
    }
  }

  private executeUnsafe(tool: string, args: Record<string, unknown>): unknown {
    switch (tool) {
      case 'lab_assistant_state':
        return this.snapshot()
      case 'lab_assistant_ask_user': {
        const question = stringArg(args, 'question')
        if (!question) throw new Error('A question is required.')
        const existing = this.state.questions.find((item) => item.status === 'open' && item.question === question)
        if (existing) return clone(existing)
        const created: LabAssistantQuestion = {
          id: `question-${this.state.questions.length + 1}`,
          question,
          options: stringArray(args, 'options'),
          status: 'open'
        }
        this.state.questions.push(created)
        return clone(created)
      }
      case 'lab_assistant_message_agent': {
        const agentId = stringArg(args, 'agent_id')
        const message = stringArg(args, 'message')
        const agent = this.state.agents.find((item) => item.id === agentId)
        if (!agent) throw new Error(`Agent ${agentId || '(missing)'} does not exist.`)
        if (!message) throw new Error('A message is required.')
        return { delivered: true, agentId, message }
      }
      case 'lab_assistant_order_work_items': {
        const targetProject = stringArg(args, 'project_id')
        const ids = stringArray(args, 'work_item_ids')
        if (!this.state.projects.some((project) => project.id === targetProject)) throw new Error(`Project ${targetProject} does not exist.`)
        if (ids.length < 2) throw new Error('An order needs at least two work items.')
        const invalid = ids.find((id) => !this.state.workItems.some((item) => item.id === id && item.projectId === targetProject))
        if (invalid) throw new Error(`Work item ${invalid} is not in project ${targetProject}.`)
        if (new Set(ids).size !== ids.length) throw new Error('A work item can appear in the order only once.')
        this.state.workItemOrder[targetProject] = ids
        return { projectId: targetProject, workItemIds: ids }
      }
      case 'lab_assistant_update_work_item': {
        const id = stringArg(args, 'work_item_id')
        const state = stringArg(args, 'state') as LabAssistantWorkState
        const item = this.state.workItems.find((candidate) => candidate.id === id)
        if (!item) throw new Error(`Work item ${id || '(missing)'} does not exist.`)
        if (!['inbox', 'ready', 'blocked', 'running', 'review', 'done'].includes(state)) throw new Error(`Invalid work item state: ${state}.`)
        item.state = state
        return { ...clone(item), note: stringArg(args, 'note') || undefined }
      }
      case 'lab_assistant_prepare_release': {
        const targetProject = stringArg(args, 'project_id')
        const channel = stringArg(args, 'channel') as LabAssistantRelease['channel']
        const bump = stringArg(args, 'bump') as LabAssistantRelease['bump']
        if (!this.state.projects.some((project) => project.id === targetProject)) throw new Error(`Project ${targetProject} does not exist.`)
        if (channel !== 'stable' && channel !== 'beta') throw new Error('Release channel must be stable or beta.')
        if (!['patch', 'minor', 'major'].includes(bump)) throw new Error('Release bump must be patch, minor, or major.')
        const release: LabAssistantRelease = {
          id: `release-${this.state.releases.length + 1}`,
          projectId: targetProject,
          channel,
          bump,
          status: 'prepared'
        }
        this.state.releases.push(release)
        return { ...clone(release), preflight: 'passed', approvalRequired: channel === 'stable' }
      }
      case 'lab_assistant_dispatch_release': {
        const id = stringArg(args, 'release_id')
        const release = this.state.releases.find((item) => item.id === id)
        if (!release) throw new Error(`Release ${id || '(missing)'} does not exist.`)
        if (release.status !== 'approved') throw new Error(`Release ${id} requires user approval before dispatch.`)
        release.status = 'dispatched'
        return clone(release)
      }
      default:
        throw new Error(`Unknown Lab Assistant tool: ${tool}`)
    }
  }
}
