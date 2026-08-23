import React, { useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { DiffLine } from '../lib/diff'
import { ignoreWhitespaceChanges } from '../lib/diff'
import { DiffLines, type DiffMode } from './DiffLines'
import { ChevronIcon } from './icons'
import type { AddReviewCommentInput, ReviewComment, ReviewProviderSummary } from '@shared/review'

export interface DiffFileData {
  path: string
  additions: number
  deletions: number
  lines: DiffLine[]
}

const DIFF_MODE_KEY = 'boss.diffMode'
const DIFF_IGNORE_WS_KEY = 'boss.diffIgnoreWhitespace'

function savedDiffMode(): DiffMode {
  try {
    return localStorage.getItem(DIFF_MODE_KEY) === 'split' ? 'split' : 'unified'
  } catch {
    return 'unified'
  }
}

function savedIgnoreWhitespace(): boolean {
  try {
    return localStorage.getItem(DIFF_IGNORE_WS_KEY) === '1'
  } catch {
    return false
  }
}

export function DiffReview({
  files,
  loading,
  error,
  showList = true,
  comments = [],
  provider,
  canPublish = false,
  onAddComment
}: {
  files: DiffFileData[]
  loading?: boolean
  error?: string
  showList?: boolean
  comments?: ReviewComment[]
  provider?: ReviewProviderSummary
  canPublish?: boolean
  onAddComment?: (input: AddReviewCommentInput, publish: boolean) => Promise<void>
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [allCollapsed, setAllCollapsed] = useState(false)
  const [listWidth, setListWidth] = useState(260)
  const [mode, setMode] = useState<DiffMode>(savedDiffMode)
  const [ignoreWs, setIgnoreWs] = useState(savedIgnoreWhitespace)

  const switchMode = (next: DiffMode): void => {
    setMode(next)
    try {
      localStorage.setItem(DIFF_MODE_KEY, next)
    } catch { /* private mode */ }
  }

  const switchIgnoreWs = (next: boolean): void => {
    setIgnoreWs(next)
    try {
      localStorage.setItem(DIFF_IGNORE_WS_KEY, next ? '1' : '0')
    } catch { /* private mode */ }
  }

  const onListResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startW = listWidth
    const move = (ev: MouseEvent): void => {
      setListWidth(Math.min(Math.max(startW + (ev.clientX - startX), 180), 460))
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = q ? files.filter((f) => f.path.toLowerCase().includes(q)) : files
    if (!ignoreWs) return list
    // Whitespace-only churn folds back into context, so the stats are
    // recomputed from what is actually drawn rather than reused.
    return list.map((f) => {
      const lines = ignoreWhitespaceChanges(f.lines)
      return {
        ...f,
        lines,
        additions: lines.filter((l) => l.kind === 'add').length,
        deletions: lines.filter((l) => l.kind === 'del').length
      }
    })
  }, [files, query, ignoreWs])

  const totalAdds = filtered.reduce((a, f) => a + f.additions, 0)
  const totalDels = filtered.reduce((a, f) => a + f.deletions, 0)

  const toggle = (path: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const toggleAll = (): void => {
    const nextAll = !allCollapsed
    setAllCollapsed(nextAll)
    setCollapsed(nextAll ? new Set(files.map((f) => f.path)) : new Set())
  }

  // Only the files near the viewport are mounted. Rendering every file's diff
  // at once was tens of thousands of DOM nodes for a branch-sized review —
  // enough to make scrolling and typing a comment feel broken.
  //
  // Virtualised by file rather than by line: files are the unit you read one
  // at a time, and it avoids a virtualiser inside every file. Heights are
  // measured rather than guessed, since a diff can be three lines or three
  // thousand.
  const stackRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => stackRef.current,
    estimateSize: (index) => {
      const file = filtered[index]
      if (!file || collapsed.has(file.path)) return 44
      // A line is about 20px, plus the header. Only a first guess: measureElement
      // corrects it once the card is on screen.
      return 44 + Math.min(file.lines.length, 400) * 20
    },
    getItemKey: (index) => filtered[index]?.path ?? index,
    overscan: 2
  })

  const jump = (path: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      next.delete(path)
      return next
    })
    const index = filtered.findIndex((file) => file.path === path)
    // Through the virtualiser: the card may not be mounted to scroll to.
    if (index >= 0) setTimeout(() => virtualizer.scrollToIndex(index, { align: 'start' }), 40)
  }

  return (
    <div className="diff-review">
      {showList && (
        <div className="pane pane-list diff-files" style={{ width: listWidth }}>
          <input
            className="diff-search"
            placeholder="Filter files…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
          />
          <div className="diff-total">
            <span>{filtered.length} file{filtered.length === 1 ? '' : 's'}</span>
            <span className="diff-total-stats">
              <span className="add">+{totalAdds}</span>
              <span className="del">−{totalDels}</span>
            </span>
          </div>
          <div className="diff-file-list">
            {filtered.map((f) => (
              <div key={f.path} className="file-row" onClick={() => jump(f.path)}>
                <span className="diff-file-path">{f.path}</span>
                <span className="stat">
                  <span className="add">+{f.additions}</span> <span className="del">−{f.deletions}</span>
                </span>
              </div>
            ))}
            {!loading && filtered.length === 0 && <div className="empty-inline">{error || 'No changes'}</div>}
          </div>
          <div className="diff-files-resizer" onMouseDown={onListResize} />
        </div>
      )}
      <div className="diff-stack">
        <div className="diff-stack-head">
          <span className="diff-stack-title">Files changed</span>
          <span className="diff-stack-total">
            <span className="add">+{totalAdds}</span> <span className="del">−{totalDels}</span>
          </span>
          {files.length > 0 && (
            <div className="diff-stack-actions" role="group" aria-label="Diff options">
              <div className="diff-mode-toggle" role="group" aria-label="Diff layout">
                <button className={mode === 'unified' ? 'active' : ''} onClick={() => switchMode('unified')} title="One column, deletions above additions">Unified</button>
                <button className={mode === 'split' ? 'active' : ''} onClick={() => switchMode('split')} title="Old and new side by side">Split</button>
              </div>
              <button
                className={`btn-ghost diff-whitespace-toggle ${ignoreWs ? 'active' : ''}`}
                onClick={() => switchIgnoreWs(!ignoreWs)}
                title="Hide changes that only move space"
                aria-pressed={ignoreWs}
              >
                Ignore whitespace
              </button>
              <button className="btn-ghost" onClick={toggleAll}>
                {allCollapsed ? 'Expand all' : 'Collapse all'}
              </button>
            </div>
          )}
        </div>
        <div className="diff-stack-body" ref={stackRef}>
          {loading ? <div className="empty-inline">Loading…</div> : null}
          <div className="diff-stack-runway" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const f = filtered[item.index]
              if (!f) return null
              const isCollapsed = collapsed.has(f.path)
              return (
                <div
                  key={f.path}
                  className="diff-card"
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  <button className="diff-card-head" onClick={() => toggle(f.path)}>
                    <span className={`diff-chevron ${isCollapsed ? '' : 'open'}`}>
                      <ChevronIcon size={13} />
                    </span>
                    <span className="diff-card-path">{f.path}</span>
                    <span className="diff-card-stats">
                      <span className="add">+{f.additions}</span> <span className="del">−{f.deletions}</span>
                    </span>
                  </button>
                  {!isCollapsed ? <DiffLines lines={f.lines} path={f.path} mode={mode} comments={comments} provider={provider} canPublish={canPublish} onAddComment={onAddComment} /> : null}
                </div>
              )
            })}
          </div>
          {!loading && !error && filtered.length === 0 && files.length > 0 && (
            <div className="empty-inline">No files match “{query}”</div>
          )}
          {!loading && !error && files.length === 0 && <div className="empty-inline">No changes</div>}
        </div>
      </div>
    </div>
  )
}
