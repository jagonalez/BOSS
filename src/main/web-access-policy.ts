import type { BackendRequest } from '../shared/backend'
import type { MobileAccessRole } from '../shared/mobile'

export type WebAccessRole = MobileAccessRole | 'team'

const READ_ONLY_REQUESTS = new Set<BackendRequest['type']>([
  'backend.list',
  'supervision.snapshot',
  'supervision.search',
  'thread.list',
  'thread.get',
  'thread.messages',
  'thread.todos',
  'thread.diff',
  'automation.list'
])

/** Mobile control intentionally covers only thread review/steering and
 * automations. Settings, connection management, destructive worktree
 * operations, and thread deletion stay on the desktop. */
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
  if (role === 'team') return TEAM_REQUESTS.has(type)
  return role === 'control' || READ_ONLY_REQUESTS.has(type)
}
