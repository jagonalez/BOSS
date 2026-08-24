import React, { useEffect, useMemo, useState } from 'react'
import type { AutomationReportSummary } from '@shared/report'
import { useStore, appStore } from '../state/AppState'
import { MarkdownDocument } from '../lib/text'
import { OpenCode } from '../lib/opencode'
import { refreshReports, selectSession } from '../lib/actions'
import { ChatIcon, FileIcon, ReloadIcon } from './icons'

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return 'now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

function ReportCard({ report, selected, onSelect }: {
  report: AutomationReportSummary
  selected: boolean
  onSelect: () => void
}): React.JSX.Element {
  return (
    <button className={`report-card${selected ? ' selected' : ''}${report.readAt ? '' : ' unread'}`} onClick={onSelect}>
      <span className="report-card-icon"><FileIcon size={14} /></span>
      <span className="report-card-main">
        <strong>{report.title}</strong>
        <span>{report.summary ?? 'Saved automation result'}</span>
        <small>{timeAgo(report.createdAt)}{report.projectPath ? ` · ${report.projectPath.split('/').pop()}` : ''}</small>
      </span>
      {!report.readAt ? <span className="report-unread" aria-label="Unread report" /> : null}
    </button>
  )
}

export function ReportsPage(): React.JSX.Element {
  const reports = useStore(appStore, (s) => s.reports?.reports ?? [])
  const requestedId = useStore(appStore, (s) => s.selectedReportId)
  const reportDetail = useStore(appStore, (s) => s.reportDetail)
  const [filter, setFilter] = useState<'all' | 'unread'>('all')
  const visible = useMemo(
    () => filter === 'unread' ? reports.filter((report) => !report.readAt) : reports,
    [reports, filter]
  )
  const selectedSummary = reports.find((report) => report.id === requestedId) ?? visible[0] ?? reports[0]
  const selected = reportDetail?.id === selectedSummary?.id ? reportDetail : undefined

  useEffect(() => {
    void refreshReports()
  }, [])

  useEffect(() => {
    if (!requestedId && visible[0]) appStore.setState({ selectedReportId: visible[0].id })
  }, [requestedId, visible[0]?.id])

  useEffect(() => {
    if (!selectedSummary) return
    let cancelled = false
    void OpenCode.report(selectedSummary.id).then((report) => {
      if (!cancelled) appStore.setState({ reportDetail: report })
    }).catch(() => {})
    return () => { cancelled = true }
  }, [selectedSummary?.id])

  useEffect(() => {
    if (!selectedSummary || selectedSummary.readAt) return
    void OpenCode.markReportRead(selectedSummary.id).then(() => refreshReports()).catch(() => {})
  }, [selectedSummary?.id, selectedSummary?.readAt])

  const choose = (id: string): void => appStore.setState({ selectedReportId: id, reportDetail: null })

  return (
    <div className="command-center reports-page">
      <header className="command-header">
        <div>
          <span className="command-eyebrow">BOSS</span>
          <h1>Reports</h1>
          <p>Durable results from automation runs. Open the source thread when you need the full working context.</p>
        </div>
        <button className="btn-ghost" onClick={() => void refreshReports()} title="Refresh reports">
          <ReloadIcon size={13} /> Refresh
        </button>
      </header>

      <div className="reports-layout">
        <section className="reports-inbox" aria-label="Report inbox">
          <div className="report-filters" role="group" aria-label="Report filter">
            <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All <small>{reports.length}</small></button>
            <button className={filter === 'unread' ? 'active' : ''} onClick={() => setFilter('unread')}>Unread <small>{reports.filter((report) => !report.readAt).length}</small></button>
          </div>
          <div className="report-list">
            {visible.length
              ? visible.map((report) => <ReportCard key={report.id} report={report} selected={selectedSummary?.id === report.id} onSelect={() => choose(report.id)} />)
              : <div className="command-empty">{filter === 'unread' ? 'You’re caught up.' : 'No reports yet. Completed automations will save their final results here.'}</div>}
          </div>
        </section>

        <article className="report-detail" aria-label="Report detail">
          {selectedSummary ? (
            <>
              <header className="report-detail-head">
                <div>
                  <span className={`site-badge automation-badge status-${selectedSummary.status}`}>{selectedSummary.status}</span>
                  <h2>{selectedSummary.title}</h2>
                  <p>{new Date(selectedSummary.createdAt).toLocaleString()} · {selectedSummary.automationName}</p>
                </div>
                {selectedSummary.threadId ? (
                  <button className="btn-ghost" onClick={() => selectSession(selectedSummary.threadId!, false)}>
                    <ChatIcon size={13} /> Source thread
                  </button>
                ) : null}
              </header>
              {selectedSummary.summary ? <div className="report-summary">{selectedSummary.summary}</div> : null}
              <div className="report-document">
                {selected ? <MarkdownDocument text={selected.body} /> : <div className="command-empty">Loading report…</div>}
              </div>
            </>
          ) : (
            <div className="command-empty">Select a report to read it.</div>
          )}
        </article>
      </div>
    </div>
  )
}
