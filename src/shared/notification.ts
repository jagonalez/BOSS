/** Every BOSS event worth telling someone about, in one vocabulary.
 *
 *  Named after what happened rather than where it came from, so a consumer can
 *  decide what to do without knowing whether an automation, a thread, or a task
 *  policy produced it.
 */
export type BossEventType =
  | 'task.completed'
  | 'task.failed'
  | 'task.needs_attention'
  | 'automation.completed'
  | 'automation.failed'
  | 'review.completed'
  | 'workflow.completed'
  | 'workflow.needs_attention'

export interface BossEvent {
  type: BossEventType
  /** One line, already written for a human. */
  title: string
  body: string
  threadId?: string
  projectPath?: string
  createdAt: number
}

/** Which events a channel wants.
 *
 *  'attention' is the useful default: the things that block progress, plus
 *  failures. 'all' adds routine completions, which are frequent enough to be
 *  noise on a phone. */
export type NotifyLevel = 'off' | 'attention' | 'all'

const ATTENTION_EVENTS = new Set<BossEventType>([
  'task.failed',
  'task.needs_attention',
  'automation.failed',
  'review.completed',
  'workflow.needs_attention'
])

/** Whether an event should reach a channel set to this level. */
export function shouldNotify(level: NotifyLevel, type: BossEventType): boolean {
  if (level === 'off') return false
  if (level === 'all') return true
  return ATTENTION_EVENTS.has(type)
}

/** Where the user is, which sets the bar for interrupting them.
 *
 *  - `desk` — the desktop is the front door. Everything a channel wants gets
 *    through, and a push is held back while a BOSS window is in front.
 *  - `away` — only what needs a person: decisions, reviews, failures. Routine
 *    completions wait, because a phone buzzing for finished work is what makes
 *    people turn notifications off.
 *  - `quiet` — silence, with no exceptions. Not even a failed release. Real
 *    paging stays with the user's monitoring, which already wakes them; one
 *    exception here would make the setting untrustworthy. */
export type Presence = 'desk' | 'away' | 'quiet'

export const PRESENCES: readonly Presence[] = ['desk', 'away', 'quiet']

export function isPresence(value: unknown): value is Presence {
  return typeof value === 'string' && (PRESENCES as readonly string[]).includes(value)
}

/** What each mode is called, and what it does, in the user's words. */
export const PRESENCE_LABELS: Record<Presence, { label: string; detail: string }> = {
  desk: { label: 'At my desk', detail: 'everything reaches you here' },
  away: { label: 'Away', detail: 'only what needs a decision' },
  quiet: { label: 'Do not disturb', detail: 'nothing gets through' }
}

/** Whether an event reaches a person at all, given where they are.
 *
 *  Separate from `shouldNotify`, which answers what a *channel* wants. Both
 *  have to agree: presence is the user's bar, the level is the channel's. */
export function presenceAllows(presence: Presence, type: BossEventType): boolean {
  if (presence === 'quiet') return false
  if (presence === 'away') return ATTENTION_EVENTS.has(type)
  return true
}

/** The webhook settings a surface can read and change.
 *
 *  Returned by both webhook IPC calls so a client always sees the settled
 *  state, rather than inferring it from what it just sent. */
export interface WebhookSettings {
  url: string
  /** Hold the push back while a BOSS window is focused. */
  onlyWhenAway: boolean
}
