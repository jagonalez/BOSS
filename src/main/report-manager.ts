import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Automation, AutomationRun } from '../shared/automation'
import type { BackendRequest } from '../shared/backend'
import type { AutomationReport, AutomationReportSummary, ReportsSnapshot } from '../shared/report'

interface ReportState {
  version: 1
  reports: AutomationReport[]
}

export class ReportManager {
  private loaded = false
  private reports: AutomationReport[] = []
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
      const parsed = JSON.parse(await readFile(this.stateFile, 'utf8')) as Partial<ReportState>
      if (parsed.version === 1 && Array.isArray(parsed.reports)) this.reports = parsed.reports
    } catch {
      /* First launch starts with no reports. */
    }
  }

  private snapshotNow(): ReportsSnapshot {
    return {
      reports: [...this.reports]
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((report): AutomationReportSummary => {
          const summary = { ...report } as Partial<AutomationReport>
          delete summary.body
          return summary as AutomationReportSummary
        })
    }
  }

  async snapshot(): Promise<ReportsSnapshot> {
    await this.load()
    return this.snapshotNow()
  }

  private async saveAndEmit(): Promise<void> {
    await mkdir(dirname(this.stateFile), { recursive: true })
    const state: ReportState = { version: 1, reports: this.reports }
    await writeFile(this.stateFile, JSON.stringify(state, null, 2))
    this.onChange?.(this.snapshotNow())
  }

  async create(
    automation: Automation,
    run: AutomationRun,
    body: string
  ): Promise<AutomationReport | undefined> {
    await this.load()
    const content = body.trim()
    if (!content || !run.finishedAt) return undefined
    const existing = this.reports.find((report) => report.runId === run.id)
    if (existing) return { ...existing }
    const report: AutomationReport = {
      id: randomUUID(),
      automationId: automation.id,
      automationName: automation.name,
      runId: run.id,
      ...(run.threadId ? { threadId: run.threadId } : {}),
      projectPath: automation.projectPath,
      title: automation.name,
      ...(run.summary ? { summary: run.summary } : {}),
      body: content,
      status: run.status,
      createdAt: run.finishedAt
    }
    this.reports.push(report)
    await this.saveAndEmit()
    return { ...report }
  }

  async markRead(id: string): Promise<AutomationReport> {
    await this.load()
    const report = this.reports.find((item) => item.id === id)
    if (!report) throw new Error('Report not found.')
    if (!report.readAt) {
      report.readAt = Date.now()
      await this.saveAndEmit()
    }
    return { ...report }
  }

  async removeForAutomation(automationId: string): Promise<void> {
    await this.load()
    const next = this.reports.filter((report) => report.automationId !== automationId)
    if (next.length === this.reports.length) return
    this.reports = next
    await this.saveAndEmit()
  }

  async removeForRuns(runIds: string[]): Promise<void> {
    if (runIds.length === 0) return
    await this.load()
    const drop = new Set(runIds)
    const next = this.reports.filter((report) => !drop.has(report.runId))
    if (next.length === this.reports.length) return
    this.reports = next
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
      default:
        throw new Error(`Unsupported report request: ${request.type}`)
    }
  }
}
