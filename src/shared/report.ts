import type { AutomationRunStatus } from './automation'

/** A durable, human-facing result produced by an automation run.
 *
 * Threads remain the provenance and debugging surface. Reports copy the final
 * answer so pruning a thread never turns the result into an empty shell.
 */
export interface AutomationReport {
  id: string
  automationId: string
  automationName: string
  runId: string
  threadId?: string
  projectPath: string
  title: string
  summary?: string
  body: string
  status: AutomationRunStatus
  createdAt: number
  readAt?: number
}

export type AutomationReportSummary = Omit<AutomationReport, 'body'>

export interface ReportsSnapshot {
  reports: AutomationReportSummary[]
}

/** Remove the machine-readable summary instruction from the presentation copy.
 * It is useful metadata, but a poor final paragraph in a report. */
export function reportBodyFromAssistantText(text: string): string {
  const lines = text.trim().split('\n')
  let last = lines.length - 1
  while (last >= 0 && !lines[last].trim()) last -= 1
  const match = last >= 0 ? lines[last].trim().match(/^SUMMARY:\s*(.+)$/i) : null
  if (match) lines.splice(last, 1)
  return lines.join('\n').trim() || match?.[1].trim() || ''
}
