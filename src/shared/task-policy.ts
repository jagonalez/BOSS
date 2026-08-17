import type { BackendId } from './backend'
import type { ThreadUsageTotals } from './supervision'

export interface TaskBudget {
  maxRuns?: number
  maxTokens?: number
  maxDurationMinutes?: number
}

export interface ReviewerPolicy {
  backendId: BackendId
  instruction?: string
}

export interface FallbackPolicy {
  backendId: BackendId
  trigger: 'error' | 'interrupted' | 'either'
}

export interface TaskPolicy {
  goal: string
  budget: TaskBudget
  reviewers: ReviewerPolicy[]
  fallback?: FallbackPolicy
}

export const EMPTY_TASK_POLICY: TaskPolicy = { goal: '', budget: {}, reviewers: [] }

/** How a run ended. Reviewers run after a clean finish; fallback answers the
 *  other two. A run the user stopped on purpose is neither. */
export type RunOutcome = 'completed' | 'error' | 'interrupted'

export type ReviewVerdict = 'pass' | 'changes-requested'

export interface ReviewerRun {
  backendId: BackendId
  threadId: string
  startedAt: number
  finishedAt?: number
  verdict?: ReviewVerdict
  notes?: string[]
}

/** What the policy has actually done for a thread, as opposed to what the user
 *  configured. Kept beside the policy so a surface can show review progress
 *  without asking every reviewer thread for its state. */
export interface TaskPolicyState {
  reviewers: ReviewerRun[]
  /** Index of the reviewer that should run next. */
  cursor: number
  fallbackThreadId?: string
  fallbackAt?: number
}

export const EMPTY_TASK_POLICY_STATE: TaskPolicyState = { reviewers: [], cursor: 0 }

/** Whether the fallback should fire for how this run ended. */
export function fallbackApplies(policy: TaskPolicy | undefined, outcome: RunOutcome): boolean {
  const trigger = policy?.fallback?.trigger
  if (!trigger) return false
  if (trigger === 'either') return outcome === 'error' || outcome === 'interrupted'
  return trigger === outcome
}

/** Read a reviewer's verdict out of its closing message.
 *
 *  The contract asked of a reviewer is a final line of PASS or
 *  CHANGES_REQUESTED. Anything else is treated as no verdict yet rather than a
 *  pass, so a reviewer that rambles cannot silently approve the work. */
export function parseReviewVerdict(text: string): { verdict: ReviewVerdict; notes: string[] } | undefined {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  // Scan from the end: the verdict is the reviewer's closing statement, and an
  // earlier mention is usually the reviewer restating the instruction.
  let index = -1
  for (let position = lines.length - 1; position >= 0; position -= 1) {
    if (/^(PASS|CHANGES_REQUESTED)\b/i.test(lines[position])) {
      index = position
      break
    }
  }
  if (index === -1) return undefined
  const verdict: ReviewVerdict = /^PASS\b/i.test(lines[index]) ? 'pass' : 'changes-requested'
  const notes = lines.slice(index + 1)
    .filter((line) => line.startsWith('-') || line.startsWith('*'))
    .map((line) => line.replace(/^[-*]\s*/, ''))
    .filter(Boolean)
    .slice(0, 20)
  return { verdict, notes }
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined
}

export function normalizeTaskPolicy(policy: TaskPolicy): TaskPolicy {
  const maxDurationMinutes = typeof policy.budget.maxDurationMinutes === 'number'
    && Number.isFinite(policy.budget.maxDurationMinutes)
    && policy.budget.maxDurationMinutes > 0
    ? policy.budget.maxDurationMinutes
    : undefined
  return {
    goal: policy.goal.trim().slice(0, 2_000),
    budget: {
      maxRuns: positiveInteger(policy.budget.maxRuns),
      maxTokens: positiveInteger(policy.budget.maxTokens),
      maxDurationMinutes
    },
    reviewers: policy.reviewers.slice(0, 5).map((reviewer) => ({
      backendId: reviewer.backendId,
      instruction: reviewer.instruction?.trim().slice(0, 1_000) || undefined
    })),
    fallback: policy.fallback ? { ...policy.fallback } : undefined
  }
}

export function budgetViolation(policy: TaskPolicy | undefined, usage: ThreadUsageTotals): string | undefined {
  const budget = policy?.budget
  if (!budget) return undefined
  if (budget.maxRuns !== undefined && usage.runs >= budget.maxRuns) {
    return `Run budget reached (${usage.runs}/${budget.maxRuns}).`
  }
  if (budget.maxTokens !== undefined && (usage.tokens ?? 0) >= budget.maxTokens) {
    return `Reported token budget reached (${usage.tokens ?? 0}/${budget.maxTokens}).`
  }
  const limitMs = budget.maxDurationMinutes === undefined ? undefined : budget.maxDurationMinutes * 60_000
  if (limitMs !== undefined && usage.durationMs >= limitMs) {
    return `Time budget reached (${Math.round(usage.durationMs / 60_000)}m/${budget.maxDurationMinutes}m).`
  }
  return undefined
}
