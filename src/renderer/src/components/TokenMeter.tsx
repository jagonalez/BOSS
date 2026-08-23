import React, { useEffect, useState } from 'react'
import type { ThreadUsageReport } from '@shared/supervision'
import { OpenCode } from '../lib/opencode'
import { compactMeter, usageDetailRows } from '../lib/token-meter'

/** Reported token/run usage for the active thread, beside the composer.
 *
 *  Polls the same recorded metrics Command Center totals, so the meter needs
 *  no new bookkeeping and agrees with what supervision reports. Renders
 *  nothing until a backend has actually reported something — an empty meter
 *  would read as a broken one — and expands to a breakdown on click. */
export function TokenMeter({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const [report, setReport] = useState<ThreadUsageReport | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let disposed = false
    setReport(null)
    setOpen(false)
    const refresh = (): void => {
      void OpenCode.threadUsage(sessionId).then((value) => {
        if (!disposed) setReport(value)
      }).catch(() => {})
    }
    refresh()
    const timer = window.setInterval(refresh, 5_000)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [sessionId])

  // Effects run after render, so the previous thread's report can still be in
  // state for one frame after a tab switch. The id returned by main makes that
  // stale value harmless even before the effect clears it.
  const currentReport = report?.threadId === sessionId ? report : null
  const summary = currentReport ? compactMeter(currentReport) : null
  if (!currentReport || !summary) return null
  return (
    <div className="token-meter">
      <button
        className={`token-meter-toggle ${open ? 'open' : ''}`}
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        title="Token usage reported for this thread"
      >
        {summary}
      </button>
      {open ? (
        <div className="token-meter-detail" aria-label="Token usage detail">
          {usageDetailRows(currentReport).map((row) => (
            <div className="token-meter-row" key={row.label}>
              <span>{row.label}</span>
              <strong>{row.value}</strong>
            </div>
          ))}
          <small className="token-meter-note">Only tokens the backend reports are counted.</small>
        </div>
      ) : null}
    </div>
  )
}
