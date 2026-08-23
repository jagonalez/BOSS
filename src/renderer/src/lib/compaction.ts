import type { Part } from '@shared/opencode'

function tokenCount(part: Pick<Part, 'state'>, key: 'preTokens' | 'postTokens'): number | undefined {
  const value = part.state?.metadata?.[key]
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function shortNumber(value: number): string {
  const compact = (divisor: number, suffix: string): string => {
    const scaled = value / divisor
    const digits = scaled < 10 && !Number.isInteger(scaled) ? 1 : 0
    return `${scaled.toFixed(digits).replace(/\.0$/, '')}${suffix}`
  }
  if (value >= 1_000_000) return compact(1_000_000, 'M')
  if (value >= 1_000) return compact(1_000, 'K')
  return String(Math.round(value))
}

/** User-facing copy for both native and BOSS-authored compaction parts. */
export function compactionLabel(part: Pick<Part, 'auto' | 'overflow' | 'state'>): string {
  if (part.overflow) return 'Earlier context was omitted to fit the model’s context window.'

  const base = part.auto
    ? 'Context compacted automatically — earlier messages were summarized.'
    : 'Context compacted — earlier messages were summarized.'
  const before = tokenCount(part, 'preTokens')
  const after = tokenCount(part, 'postTokens')
  return before !== undefined && after !== undefined
    ? `${base} ${shortNumber(before)} → ${shortNumber(after)} tokens.`
    : base
}
