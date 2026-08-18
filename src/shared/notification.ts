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
  'review.completed'
])

/** Whether an event should reach a channel set to this level. */
export function shouldNotify(level: NotifyLevel, type: BossEventType): boolean {
  if (level === 'off') return false
  if (level === 'all') return true
  return ATTENTION_EVENTS.has(type)
}
