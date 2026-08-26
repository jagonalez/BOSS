// Relative, with the extension, so this module also loads under Node's
// type-stripping test runner, which cannot resolve the @shared bundler alias.
// @ts-expect-error Application builds use bundler resolution.
import { REPORT_TOOL_DESCRIPTIONS, THREAD_TOOL_DESCRIPTIONS, WORKFLOW_TOOL_DESCRIPTIONS } from '../../shared/thread-bus.ts'
import type { LabToolFunction } from './lab-tools'

/** Lab's view of BOSS host tools.
 *
 *  Lab has no MCP client, so collaboration and publishing reach it as external tools the
 *  host injects. That is what lets an assistant work across threads rather than
 *  only inside one: it can see its siblings, read what they are doing, hand work
 *  to a new worktree thread, and pass a message back.
 *
 *  Descriptions come from the shared table the other backends use, because what
 *  an agent is told about a tool decides whether it reaches for one, and four
 *  drifting copies of that sentence is how a tool stops getting used. */

const threadId = { type: 'string', description: 'BOSS thread id returned by boss_threads_list.' }

export const THREAD_TOOL_DEFINITIONS: LabToolFunction[] = [
  {
    type: 'function',
    function: {
      name: 'boss_threads_list',
      description: THREAD_TOOL_DESCRIPTIONS.list,
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'boss_threads_read',
      description: THREAD_TOOL_DESCRIPTIONS.read,
      parameters: {
        type: 'object',
        properties: { threadId, limit: { type: 'integer', description: 'How many recent messages to read (1-20, default 8).' } },
        required: ['threadId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'boss_threads_send',
      description: THREAD_TOOL_DESCRIPTIONS.send,
      parameters: {
        type: 'object',
        properties: {
          threadId,
          message: { type: 'string', description: 'Concise context, question, or requested task.' },
          expectsReply: { type: 'boolean', description: 'Whether a reply is wanted (default true).' }
        },
        required: ['threadId', 'message']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'boss_threads_reply',
      description: THREAD_TOOL_DESCRIPTIONS.reply,
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: 'string', description: 'Message id from the incoming BOSS thread message.' },
          message: { type: 'string', description: 'Reply for the sending thread.' }
        },
        required: ['messageId', 'message']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'boss_threads_spawn_worktree',
      description: THREAD_TOOL_DESCRIPTIONS.spawnWorktree,
      parameters: {
        type: 'object',
        properties: {
          instruction: { type: 'string', description: THREAD_TOOL_DESCRIPTIONS.spawnWorktreeInstruction },
          agent: { type: 'string', description: THREAD_TOOL_DESCRIPTIONS.spawnWorktreeAgent }
        },
        required: ['instruction']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'boss_git_create_change_request',
      description: THREAD_TOOL_DESCRIPTIONS.createChangeRequest,
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: THREAD_TOOL_DESCRIPTIONS.createChangeRequestTitle },
          body: { type: 'string', description: THREAD_TOOL_DESCRIPTIONS.createChangeRequestBody },
          baseBranch: { type: 'string', description: THREAD_TOOL_DESCRIPTIONS.createChangeRequestBase },
          draft: { type: 'boolean', description: THREAD_TOOL_DESCRIPTIONS.createChangeRequestDraft }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'boss_reports_create',
      description: REPORT_TOOL_DESCRIPTIONS.create,
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: REPORT_TOOL_DESCRIPTIONS.title },
          summary: { type: 'string', description: REPORT_TOOL_DESCRIPTIONS.summary },
          body: { type: 'string', description: REPORT_TOOL_DESCRIPTIONS.body }
        },
        required: ['title', 'body']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'boss_reports_update',
      description: REPORT_TOOL_DESCRIPTIONS.update,
      parameters: {
        type: 'object',
        properties: {
          reportId: { type: 'string', description: REPORT_TOOL_DESCRIPTIONS.reportId },
          title: { type: 'string', description: REPORT_TOOL_DESCRIPTIONS.title },
          summary: { type: 'string', description: REPORT_TOOL_DESCRIPTIONS.summary },
          body: { type: 'string', description: REPORT_TOOL_DESCRIPTIONS.body }
        },
        required: ['reportId']
      }
    }
  }
,
  {
    type: 'function',
    function: {
      name: 'boss_workflow_list',
      description: WORKFLOW_TOOL_DESCRIPTIONS.list,
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'boss_workflow_create',
      description: WORKFLOW_TOOL_DESCRIPTIONS.create,
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: WORKFLOW_TOOL_DESCRIPTIONS.name },
          description: { type: 'string', description: WORKFLOW_TOOL_DESCRIPTIONS.description },
          script: { type: 'string', description: WORKFLOW_TOOL_DESCRIPTIONS.script },
          cron: { type: 'string', description: WORKFLOW_TOOL_DESCRIPTIONS.cron },
          eventType: { type: 'string', description: WORKFLOW_TOOL_DESCRIPTIONS.eventType },
          eventFilters: { type: 'object', description: WORKFLOW_TOOL_DESCRIPTIONS.eventFilters }
        },
        required: ['name', 'script']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'boss_workflow_update',
      description: WORKFLOW_TOOL_DESCRIPTIONS.update,
      parameters: {
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
        required: ['workflowId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'boss_workflow_run',
      description: WORKFLOW_TOOL_DESCRIPTIONS.run,
      parameters: {
        type: 'object',
        properties: { workflowId: { type: 'string', description: WORKFLOW_TOOL_DESCRIPTIONS.workflowId } },
        required: ['workflowId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'boss_workflow_runs',
      description: WORKFLOW_TOOL_DESCRIPTIONS.runs,
      parameters: {
        type: 'object',
        properties: {
          workflowId: { type: 'string', description: WORKFLOW_TOOL_DESCRIPTIONS.workflowId },
          limit: { type: 'integer', description: WORKFLOW_TOOL_DESCRIPTIONS.limit }
        }
      }
    }
  }
]

const THREAD_TOOL_NAMES = new Set(THREAD_TOOL_DEFINITIONS.map((tool) => tool.function.name))

export function isThreadTool(name: string): boolean {
  return THREAD_TOOL_NAMES.has(name)
}
