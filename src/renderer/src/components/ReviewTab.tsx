import React, { useState } from 'react'
import { useStore, appStore } from '../state/AppState'
import { unifiedDiff, type DiffLine } from '../lib/diff'

function DiffLines({ lines }: { lines: DiffLine[] }): React.JSX.Element {
  return (
    <div className="diff-view">
      {lines.map((line, i) => (
        <div key={i} className={`diff-line ${line.kind}`}>
          <span className="ln">{line.oldNo ?? ''}</span>
          <span className="ln">{line.newNo ?? ''}</span>
          <span>{line.text || ' '}</span>
        </div>
      ))}
    </div>
  )
}

export function ReviewTab(): React.JSX.Element {
  const diffs = useStore(appStore, (s) => s.diffs)
  const activeSessionId = useStore(appStore, (s) => s.activeSessionId)
  const [selected, setSelected] = useState<string | null>(null)

  if (!activeSessionId) {
    return <div className="empty"><p>Open a chat to review changes.</p></div>
  }

  if (!diffs) {
    return <div className="empty"><p>Loading diff…</p></div>
  }

  if (diffs.length === 0) {
    return <div className="empty"><p>No changes yet.</p></div>
  }

  const active = diffs.find((d) => d.path === selected) ?? diffs[0]
  const original = active.original ?? active.before ?? ''
  const content = active.content ?? active.after ?? ''

  return (
    <div className="two-pane">
      <div className="pane pane-list">
        {diffs.map((diff) => (
          <div
            key={diff.path}
            className={`file-row ${diff.path === active.path ? 'active' : ''}`}
            onClick={() => setSelected(diff.path)}
          >
            <span>{diff.path}</span>
            <span className="stat">
              <span className="add">+{diff.additions ?? 0}</span> <span className="del">−{diff.deletions ?? 0}</span>
            </span>
          </div>
        ))}
      </div>
      <DiffLines lines={unifiedDiff(original, content)} />
    </div>
  )
}
