import type { BackendRequest } from '../shared/backend'

export type WebAccessRole = 'control' | 'team'

/** Mobile control intentionally covers only thread review/steering and
 * automations. Settings, connection management, destructive worktree
 * operations, and thread deletion stay on the desktop. */
const CONTROL_REQUESTS = new Set<BackendRequest['type']>([
  'backend.list',
  'thread.list',
  'thread.get',
  'thread.messages',
  'thread.send',
  'thread.abort',
  'thread.todos',
  'thread.permission',
  'thread.diff',
  'automation.list',
  'automation.run',
  'automation.stop'
])

/** A team token is a separate capability: it can only see and mutate the
 * shared board, never private threads, approvals, automations, or settings. */
const TEAM_REQUESTS = new Set<BackendRequest['type']>([
  'team.snapshot',
  'team.board.update',
  'team.task.create',
  'team.task.update',
  'team.task.delete',
  'team.task.claim',
  'team.peer.join'
])

export function webAccessRequestAllowed(role: WebAccessRole, type: BackendRequest['type']): boolean {
  return (role === 'team' ? TEAM_REQUESTS : CONTROL_REQUESTS).has(type)
}
