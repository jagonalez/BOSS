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
