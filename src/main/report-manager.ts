import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AutomationRun } from '../shared/automation'
import type { BackendRequest } from '../shared/backend'
import type { AgentReportInput, AgentReportPatch, Report, ReportSummary, ReportsSnapshot } from '../shared/report'

interface ReportState {
  version: 2
  reports: Report[]
}

interface LegacyAutomationReport {
  id: string
  automationId: string
  automationName: string
  runId: string
  threadId?: string
  projectPath: string
  title: string
  summary?: string
  body: string
  status: AutomationRun['status']
  createdAt: number
  readAt?: number
}

const MAX_TITLE = 200
const MAX_SUMMARY = 1_000
const MAX_BODY = 250_000

function requiredText(value: string, label: string, max: number): string {
  const text = value.trim()
  if (!text) throw new Error(`${label} is required.`)
  if (text.length > max) throw new Error(`${label} is limited to ${max.toLocaleString()} characters.`)
  return text
}

function optionalText(value: string | undefined, label: string, max: number): string | undefined {
  if (value === undefined) return undefined
  const text = value.trim()
  if (text.length > max) throw new Error(`${label} is limited to ${max.toLocaleString()} characters.`)
  return text || undefined
}

export class ReportManager {
  private loaded = false
  private reports: Report[] = []
  private readonly stateFile: string
  private readonly onChange?: (snapshot: ReportsSnapshot) => void

  constructor(
    stateFile: string,
    onChange?: (snapshot: ReportsSnapshot) => void
  ) {
    this.stateFile = stateFile
    this.onChange = onChange
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed = JSON.parse(await readFile(this.stateFile, 'utf8')) as {
        version?: number
        reports?: Array<Report | LegacyAutomationReport>
      }
      if (parsed.version === 2 && Array.isArray(parsed.reports)) {
        this.reports = parsed.reports as Report[]
      } else if (parsed.version === 1 && Array.isArray(parsed.reports)) {
        this.reports = (parsed.reports as LegacyAutomationReport[]).map((report) => ({
          id: report.id,
          source: {
            kind: 'automation',
            automationId: report.automationId,
            automationName: report.automationName,
            runId: report.runId,
            status: report.status
          },
          ...(report.threadId ? { threadId: report.threadId } : {}),
          projectPath: report.projectPath,
          title: report.title,
          ...(report.summary ? { summary: report.summary } : {}),
          body: report.body,
          createdAt: report.createdAt,
          updatedAt: report.createdAt,
          ...(report.readAt ? { readAt: report.readAt } : {})
        }))
        await this.saveAndEmit()
      }
    } catch {
      /* First launch starts with no reports. */
    }
  }

  private snapshotNow(): ReportsSnapshot {
    return {
      reports: [...this.reports]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((report): ReportSummary => {
          const summary = { ...report } as Partial<Report>
          delete summary.body
          return summary as ReportSummary
        })
    }
  }

  async snapshot(): Promise<ReportsSnapshot> {
    await this.load()
    return this.snapshotNow()
  }

  private async saveAndEmit(): Promise<void> {
    await mkdir(dirname(this.stateFile), { recursive: true })
    const state: ReportState = { version: 2, reports: this.reports }
    await writeFile(this.stateFile, JSON.stringify(state, null, 2))
    this.onChange?.(this.snapshotNow())
  }

  async createFromAgent(input: AgentReportInput): Promise<Report> {
    await this.load()
    const now = Date.now()
    const report: Report = {
      id: randomUUID(),
      source: { kind: 'agent', backendId: input.backendId },
      threadId: input.threadId,
      projectPath: input.projectPath,
      title: requiredText(input.title, 'Report title', MAX_TITLE),
      ...(optionalText(input.summary, 'Report summary', MAX_SUMMARY) ? { summary: input.summary!.trim() } : {}),
      body: requiredText(input.body, 'Report body', MAX_BODY),
      createdAt: now,
      updatedAt: now
    }
    this.reports.push(report)
    await this.saveAndEmit()
    return { ...report }
  }

  async updateFromAgent(threadId: string, id: string, patch: AgentReportPatch): Promise<Report> {
    await this.load()
    const report = this.reports.find((item) => item.id === id)
    if (!report) throw new Error('Report not found.')
    if (report.source.kind !== 'agent' || report.threadId !== threadId) {
      throw new Error('Only the thread that created this report can update it.')
    }
    if (patch.title !== undefined) report.title = requiredText(patch.title, 'Report title', MAX_TITLE)
    if (patch.body !== undefined) report.body = requiredText(patch.body, 'Report body', MAX_BODY)
    if (patch.summary !== undefined) {
      const summary = optionalText(patch.summary, 'Report summary', MAX_SUMMARY)
      if (summary) report.summary = summary
      else delete report.summary
    }
    report.updatedAt = Date.now()
    delete report.readAt
    await this.saveAndEmit()
    return { ...report }
  }

  async markRead(id: string): Promise<Report> {
    await this.load()
    const report = this.reports.find((item) => item.id === id)
    if (!report) throw new Error('Report not found.')
    if (!report.readAt) {
      report.readAt = Date.now()
      await this.saveAndEmit()
    }
    return { ...report }
  }

  async delete(id: string): Promise<void> {
    await this.load()
    const index = this.reports.findIndex((item) => item.id === id)
    if (index === -1) throw new Error('Report not found.')
    this.reports.splice(index, 1)
    await this.saveAndEmit()
  }

  async handle(request: BackendRequest): Promise<unknown> {
    switch (request.type) {
      case 'report.list':
        return this.snapshot()
      case 'report.get': {
        await this.load()
        const report = this.reports.find((item) => item.id === request.reportId)
        if (!report) throw new Error('Report not found.')
        return { ...report }
      }
      case 'report.read':
        return this.markRead(request.reportId)
      case 'report.delete':
        return this.delete(request.reportId)
      default:
        throw new Error(`Unsupported report request: ${request.type}`)
    }
  }
}
