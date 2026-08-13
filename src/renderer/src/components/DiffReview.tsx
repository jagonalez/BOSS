import React, { useMemo, useRef, useState } from 'react'
import type { DiffLine } from '../lib/diff'
import { DiffLines } from './DiffLines'
import { ChevronIcon } from './icons'
import type { AddReviewCommentInput, ReviewComment, ReviewProviderSummary } from '@shared/review'

export interface DiffFileData {
  path: string
  additions: number
  deletions: number
  lines: DiffLine[]
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
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({})

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
    return q ? files.filter((f) => f.path.toLowerCase().includes(q)) : files
  }, [files, query])

  const totalAdds = files.reduce((a, f) => a + f.additions, 0)
  const totalDels = files.reduce((a, f) => a + f.deletions, 0)

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

  const jump = (path: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      next.delete(path)
      return next
    })
    setTimeout(() => cardRefs.current[path]?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 40)
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
            <button className="btn-ghost" onClick={toggleAll}>
              {allCollapsed ? 'Expand all' : 'Collapse all'}
            </button>
          )}
        </div>
        <div className="diff-stack-body">
          {loading ? <div className="empty-inline">Loading…</div> : null}
          {filtered.map((f) => {
            const isCollapsed = collapsed.has(f.path)
            return (
              <div
                key={f.path}
                className="diff-card"
                ref={(el) => {
                  cardRefs.current[f.path] = el
                }}
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
                {!isCollapsed ? <DiffLines lines={f.lines} path={f.path} comments={comments} provider={provider} canPublish={canPublish} onAddComment={onAddComment} /> : null}
              </div>
            )
          })}
          {!loading && !error && filtered.length === 0 && files.length > 0 && (
            <div className="empty-inline">No files match “{query}”</div>
          )}
          {!loading && !error && files.length === 0 && <div className="empty-inline">No changes</div>}
        </div>
      </div>
    </div>
  )
}
