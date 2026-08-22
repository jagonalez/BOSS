import type { SubscriptionUsageWindow } from '@shared/backend'

type RecordValue = Record<string, unknown>

function record(value: unknown): RecordValue | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined
}

function percent(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : undefined
}

function timestamp(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  // Codex sends Unix seconds; accepting milliseconds makes this resilient to
  // a future protocol revision without turning a reset into 1970.
  return value < 1_000_000_000_000 ? value * 1_000 : value
}

function durationLabel(minutes: unknown, fallback: string): string {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) return fallback
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}-day limit`
  if (minutes % 60 === 0) return `${minutes / 60}-hour limit`
  return `${minutes}-minute limit`
}

/** Normalise the Codex app-server's account/rateLimits/read response. */
export function codexUsageWindows(payload: unknown): { plan?: string; windows: SubscriptionUsageWindow[] } {
  const root = record(payload)
  if (!root) return { windows: [] }
  const snapshots = [root, record(root.rateLimits), ...Object.values(record(root.rateLimitsByLimitId) ?? {})]
    .map(record)
    .filter((value): value is RecordValue => Boolean(value))
  const seen = new Set<string>()
  const windows: SubscriptionUsageWindow[] = []
  let plan: string | undefined

  for (const snapshot of snapshots) {
    plan ??= typeof snapshot.planType === 'string' ? snapshot.planType : undefined
    const name = typeof snapshot.limitName === 'string' ? snapshot.limitName : undefined
    for (const [kind, rawWindow] of [['primary', snapshot.primary], ['secondary', snapshot.secondary]] as const) {
      const window = record(rawWindow)
      const usedPercent = percent(window?.usedPercent)
      if (usedPercent === undefined) continue
      const resetsAt = timestamp(window?.resetsAt)
      const label = name
        ? (kind === 'primary' ? name : `${name} (${kind})`)
        : durationLabel(window?.windowDurationMins, kind === 'primary' ? 'Usage limit' : 'Additional usage limit')
      const key = `${label}:${usedPercent}:${resetsAt ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      windows.push({ label, usedPercent, ...(resetsAt ? { resetsAt } : {}) })
    }
  }
  return { ...(plan ? { plan } : {}), windows }
}

/** Parse the human-readable, provider-owned result of Claude Code's /usage
 * command. It deliberately retains the reset wording and timezone supplied by
 * Claude rather than guessing at a date from local machine settings. */
export function claudeUsageWindows(result: unknown): SubscriptionUsageWindow[] {
  if (typeof result !== 'string') return []
  const windows: SubscriptionUsageWindow[] = []
  for (const line of result.split(/\r?\n/)) {
    const match = line.trim().match(/^(.+?):\s*(\d+(?:\.\d+)?)%\s+used\s*[·•]\s*resets\s+(.+)$/i)
    if (!match) continue
    const usedPercent = percent(Number(match[2]))
    if (usedPercent === undefined) continue
    windows.push({ label: match[1].trim(), usedPercent, resetLabel: match[3].trim() })
  }
  return windows
}
