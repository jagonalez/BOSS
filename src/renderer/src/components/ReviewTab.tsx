import React, { useState } from 'react'
import { useStore, appStore } from '../state/AppState'
import { unifiedDiff } from '../lib/diff'
import { DiffLines } from './DiffLines'
import { GitView } from './GitView'

function TurnReview(): React.JSX.Element {
  const diffs = useStore(appStore, (s) => s.diffs)
  const activeSessionId = useStore(appStore, (s) => s.activeSessionId)
  const reviewFile = useStore(appStore, (s) => s.reviewFile)

  if (!activeSessionId) {
    return <div className="empty"><p>Open a chat to review changes.</p></div>
  }
  if (!diffs) {
    return <div className="empty"><p>Loading diff…</p></div>
  }
  if (diffs.length === 0) {
    return <div className="empty"><p>No changes in this turn. Check Git for commits / working tree.</p></div>
  }

  const active = diffs.find((d) => d.path === reviewFile) ?? diffs[0]
  const original = active.original ?? active.before ?? ''
  const content = active.content ?? active.after ?? ''

  return (
    <div className="two-pane">
      <div className="pane pane-list">
        {diffs.map((diff) => (
          <div
            key={diff.path}
            className={`file-row ${diff.path === active.path ? 'active' : ''}`}
            onClick={() => appStore.setState({ reviewFile: diff.path })}
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

export function ReviewTab(): React.JSX.Element {
  const [sub, setSub] = useState<'git' | 'turn'>('git')

  return (
    <div className="review">
      <div className="review-tabs">
        <button className={`tab ${sub === 'git' ? 'active' : ''}`} onClick={() => setSub('git')}>
          Git
        </button>
        <button className={`tab ${sub === 'turn' ? 'active' : ''}`} onClick={() => setSub('turn')}>
          Last turn
        </button>
      </div>
      {sub === 'git' ? <GitView /> : <TurnReview />}
    </div>
  )
}
