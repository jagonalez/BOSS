import type { ThreadUsageReport } from '@shared/supervision'

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })

/** Compact token count, the way Command Center prints totals. */
export function formatCompact(value: number): string {
  return compact.format(value)
}

export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1_000))}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  return `${Math.floor(ms / 3_600_000)}h ${Math.round((ms % 3_600_000) / 60_000)}m`
}

/** The one-line meter beside the composer, or null when there is nothing to
 *  show. A thread whose backends never reported tokens still shows its run
 *  count; a thread with nothing recorded shows nothing at all. */
export function compactMeter(report: ThreadUsageReport): string | null {
  const parts: string[] = []
  if (report.totals.tokens !== undefined) parts.push(`${formatCompact(report.totals.tokens)} tok`)
  if (report.totals.runs > 0) {
    parts.push(`${report.totals.runs} run${report.totals.runs === 1 ? '' : 's'}`)
  }
  const left = remainingTokens(report)
  if (left !== undefined) parts.push(`${formatCompact(left)} left`)
  return parts.length ? parts.join(' · ') : null
}

/** Tokens the thread may still report under its budget, when both sides of
 *  that subtraction exist. Clamped at zero: overspending shows none left,
 *  not a negative allowance. */
export function remainingTokens(report: ThreadUsageReport): number | undefined {
  const cap = report.budget?.maxTokens
  if (cap === undefined) return undefined
  return Math.max(0, cap - (report.totals.tokens ?? 0))
}

export interface UsageDetailRow {
  label: string
  value: string
}

/** What the popover spells out: every reported number, plus how much of an
 *  existing budget the thread has spent. Rows without data are left out. */
export function usageDetailRows(report: ThreadUsageReport): UsageDetailRow[] {
  const rows: UsageDetailRow[] = []
  if (report.totals.tokens !== undefined) {
    rows.push({ label: 'Reported tokens', value: `${formatCompact(report.totals.tokens)} across ${report.totals.tokenRuns} run${report.totals.tokenRuns === 1 ? '' : 's'}` })
  }
  if (report.totals.runs > 0) rows.push({ label: 'Runs', value: String(report.totals.runs) })
  if (report.totals.durationMs > 0) rows.push({ label: 'Agent time', value: formatDuration(report.totals.durationMs) })
  if (report.totals.toolCalls > 0) rows.push({ label: 'Tool calls', value: formatCompact(report.totals.toolCalls) })
  if (report.lastRun) {
    const lastRun = report.lastRun
    const pieces = [
      lastRun.tokens !== undefined ? `${formatCompact(lastRun.tokens)} tok` : '',
      formatDuration(lastRun.durationMs),
      lastRun.status
    ].filter(Boolean)
    rows.push({ label: 'Last run', value: pieces.join(' · ') })
  }
  const budget = report.budget
  if (budget?.maxTokens !== undefined) {
    rows.push({
      label: 'Token budget',
      value: report.totals.tokens !== undefined
        ? `${formatCompact(report.totals.tokens)} of ${formatCompact(budget.maxTokens)} · ${formatCompact(remainingTokens(report)!)} left`
        : `cap ${formatCompact(budget.maxTokens)}`
    })
  }
  if (budget?.maxRuns !== undefined) {
    rows.push({
      label: 'Run budget',
      value: report.totals.runs > 0
        ? `${report.totals.runs} of ${budget.maxRuns} · ${Math.max(0, budget.maxRuns - report.totals.runs)} left`
        : `cap ${budget.maxRuns}`
    })
  }
  if (budget?.maxDurationMinutes !== undefined) {
    const capMs = budget.maxDurationMinutes * 60_000
    rows.push({
      label: 'Time budget',
      value: report.totals.durationMs > 0
        ? `${formatDuration(report.totals.durationMs)} of ${formatDuration(capMs)}`
        : `cap ${budget.maxDurationMinutes}m`
    })
  }
  return rows
}
