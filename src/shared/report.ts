import type { AutomationRunStatus } from './automation'
import type { BackendId } from './backend'

export type ReportSource =
  | { kind: 'agent'; backendId: BackendId }
  | {
      kind: 'automation'
      automationId: string
      automationName: string
      runId: string
      status: AutomationRunStatus
    }

/** A durable, human-facing artifact produced by an agent.
 *
 * A report owns a presentation copy of its content. The source thread remains
 * provenance and working context, but deleting it never empties the artifact.
 */
export interface Report {
  id: string
  source: ReportSource
  threadId?: string
  projectPath: string
  title: string
  summary?: string
  body: string
  createdAt: number
  updatedAt: number
  readAt?: number
}

export type ReportSummary = Omit<Report, 'body'>

export interface ReportsSnapshot {
  reports: ReportSummary[]
}

export interface AgentReportInput {
  threadId: string
  projectPath: string
  backendId: BackendId
  title: string
  summary?: string
  body: string
}

export interface AgentReportPatch {
  title?: string
  summary?: string
  body?: string
}
