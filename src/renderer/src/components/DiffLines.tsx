import React from 'react'
import type { DiffLine, SplitRow, WordSegment, WordSegmentKind } from '../lib/diff'
import { pairModifiedCounterparts, pairSplitLines, wordSegments } from '../lib/diff'
import { langForPath, highlightCode } from '../lib/highlight'
import type { AddReviewCommentInput, ReviewComment, ReviewProviderSummary } from '@shared/review'

export type DiffMode = 'unified' | 'split'

export function DiffLines({
  lines,
  path,
  mode = 'unified',
  comments = [],
  provider,
  canPublish = false,
  onAddComment
}: {
  lines: DiffLine[]
  path?: string
  mode?: DiffMode
  comments?: ReviewComment[]
  provider?: ReviewProviderSummary
  canPublish?: boolean
  onAddComment?: (input: AddReviewCommentInput, publish: boolean) => Promise<void>
}): React.JSX.Element {
  const lang = path ? langForPath(path) : undefined
  const [commenting, setCommenting] = React.useState<{ line: number; side: 'LEFT' | 'RIGHT' } | null>(null)
  const [body, setBody] = React.useState('')
  const [saving, setSaving] = React.useState(false)

  // Indexed once rather than filtered per line. The filter was lines ×
  // comments: 10,000 lines against 30 comments is 300,000 comparisons for a
  // handful of matches, repeated on every render.
  const byLine = React.useMemo(() => {
    const index = new Map<string, ReviewComment[]>()
    const add = (key: string, comment: ReviewComment): void => {
      const list = index.get(key) ?? []
      list.push(comment)
      index.set(key, list)
    }
    for (const comment of comments) {
      if (comment.file !== path || comment.line === null) continue
      // A comment without a side belongs to whichever line matches, which is
      // what the old per-line filter did by comparing against that line's own
      // side. Indexing it under both keeps that.
      if (comment.side) add(`${comment.side}:${comment.line}`, comment)
      else {
        add(`LEFT:${comment.line}`, comment)
        add(`RIGHT:${comment.line}`, comment)
      }
    }
    return index
  }, [comments, path])

  // Highlighting is the expensive part and depends only on the text, so it is
  // done once per set of lines rather than on every render — a comment draft
  // used to re-highlight the whole file on each keystroke.
  const highlighted = React.useMemo(() => {
    if (!lang) return null
    return lines.map((line) => {
      if (line.kind === 'hunk') return null
      try {
        return highlightCode(line.text, path)
      } catch {
        return null
      }
    })
  }, [lines, lang, path])

  // Word-level marking of modified pairs, computed once per file. Syntax
  // highlighting cannot survive being cut into fragments, so a paired line
  // whose sides differ gets word emphasis and everything else keeps its
  // language colours.
  const words = React.useMemo(() => {
    const marks = new Map<number, WordSegment[]>()
    for (const [i, j] of pairModifiedCounterparts(lines)) {
      const a = lines[i]
      const b = lines[j]
      if (!a || !b || a.text === b.text) continue
      const segments = wordSegments(a.text, b.text)
      if (!segments.some((s) => s.kind !== 'eq')) continue
      marks.set(i, segments)
      marks.set(j, segments)
    }
    return marks
  }, [lines])

  const rows = React.useMemo(() => (mode === 'split' ? pairSplitLines(lines) : []), [lines, mode])
  const rowIndex = React.useMemo(() => {
    const map = new Map<DiffLine, number>()
    lines.forEach((line, i) => map.set(line, i))
    return map
  }, [lines])

  const save = async (publish: boolean): Promise<void> => {
    if (!onAddComment || !commenting || !path || !body.trim()) return
    setSaving(true)
    try {
      await onAddComment({ body: body.trim(), file: path, line: commenting.line, side: commenting.side }, publish)
      setCommenting(null)
      setBody('')
    } catch {
      // The parent surfaces the error; retain the draft so it can be retried.
    } finally {
      setSaving(false)
    }
  }

  const contentFor = (line: DiffLine, i: number): React.ReactNode => {
    const segments = words.get(i)
    if (segments) {
      // The old side keeps deletions, the new side additions; shared words are
      // left plain so only what moved stands out.
      const kept: WordSegmentKind = line.kind === 'del' ? 'del' : 'add'
      const dropped: WordSegmentKind = line.kind === 'del' ? 'add' : 'del'
      return segments.map((segment, k) =>
        segment.kind === dropped
          ? null
          : segment.kind === kept
            ? <span key={k} className={`word-${kept}`}>{segment.text}</span>
            : segment.text
      )
    }
    const markup = highlighted?.[i]
    return markup ? <code dangerouslySetInnerHTML={{ __html: markup }} /> : line.text || ' '
  }

  const gutterButton = (number: number, side: 'LEFT' | 'RIGHT'): React.ReactNode | null => {
    if (!onAddComment) return null
    const isCommenting = commenting?.line === number && commenting.side === side
    return (
      <button
        className="diff-comment-add"
        title={`Comment on ${side === 'RIGHT' ? 'new' : 'old'} line ${number}`}
        onClick={() => {
          setCommenting(isCommenting ? null : { line: number, side })
          setBody('')
        }}
      >+
      </button>
    )
  }

  const composer = (): React.ReactNode => (
    <div className="diff-comment-composer">
      <textarea value={body} onChange={(event) => setBody(event.target.value)} placeholder={`Comment on ${path}:${commenting?.line}`} autoFocus rows={3} />
      <div>
        <button className="btn-deny" onClick={() => setCommenting(null)}>Cancel</button>
        <button className="btn-ghost" disabled={!body.trim() || saving} onClick={() => void save(false)}>Save local note</button>
        {canPublish && provider?.capabilities.publishInlineComment ? <button className="btn-allow" disabled={!body.trim() || saving} onClick={() => void save(true)}>Publish to {provider.label}</button> : null}
      </div>
    </div>
  )

  const inlineComments = (side: 'LEFT' | 'RIGHT', number: number | null): ReviewComment[] =>
    number === null ? [] : byLine.get(`${side}:${number}`) ?? []

  const commentList = (found: ReviewComment[]): React.ReactNode => found.map((comment) => (
    <div className={`diff-inline-comment ${comment.source}`} key={`${comment.source}-${comment.id}`}>
      <span className="review-avatar">{comment.author.login.slice(0, 1).toUpperCase()}</span>
      <span><strong>{comment.author.login}</strong><small>{comment.source === 'local' ? 'Local note' : provider?.label ?? 'Remote'} · {new Date(comment.createdAt).toLocaleString()}</small><p>{comment.body}</p></span>
    </div>
  ))

  if (mode === 'split') {
    return (
      <div className="diff-view split" data-mode="split">
        {rows.map((row: SplitRow, i) => (
          row.hunk ? (
            <div className="diff-line hunk span" key={i}><span className="ln" /><span className="lc">{row.hunk}</span></div>
          ) : (
            <React.Fragment key={i}>
              <div className="diff-split-row">
                <Side line={row.left} index={row.left ? rowIndex.get(row.left) ?? -1 : -1} side="LEFT" contentFor={contentFor} gutterButton={gutterButton} />
                <Side line={row.right} index={row.right ? rowIndex.get(row.right) ?? -1 : -1} side="RIGHT" contentFor={contentFor} gutterButton={gutterButton} />
              </div>
              {commentList(inlineComments('LEFT', row.left?.oldNo ?? null))}
              {commentList(inlineComments('RIGHT', row.right?.newNo ?? null))}
              {commenting && ((commenting.side === 'LEFT' && row.left && commenting.line === row.left.oldNo)
                || (commenting.side === 'RIGHT' && row.right && commenting.line === row.right.newNo))
                ? composer()
                : null}
            </React.Fragment>
          )
        ))}
      </div>
    )
  }

  return (
    <div className="diff-view" data-mode="unified">
      {lines.map((line, i) => {
        const number = line.kind === 'del' ? line.oldNo : line.newNo
        const side = line.kind === 'del' ? 'LEFT' : 'RIGHT'
        const found = inlineComments(side, number)
        const isCommenting = number !== null && commenting?.line === number && commenting.side === side
        return <React.Fragment key={i}>
          <div className={`diff-line ${line.kind} ${found.length ? 'has-comments' : ''}`}>
            <span className="ln">{number ?? ''}</span>
            {number !== null && line.kind !== 'hunk' ? gutterButton(number, side) : null}
            <span className="lc">{contentFor(line, i)}</span>
          </div>
          {commentList(found)}
          {isCommenting ? composer() : null}
        </React.Fragment>
      })}
    </div>
  )
}

function Side({
  line,
  index,
  side,
  contentFor,
  gutterButton
}: {
  line: DiffLine | null
  index: number
  side: 'LEFT' | 'RIGHT'
  contentFor: (line: DiffLine, i: number) => React.ReactNode
  gutterButton: (number: number, side: 'LEFT' | 'RIGHT') => React.ReactNode | null
}): React.JSX.Element {
  if (!line) return <div className="diff-line half empty"><span className="ln" /><span className="lc" /></div>
  const number = side === 'LEFT' ? line.oldNo : line.newNo
  return (
    <div className={`diff-line half ${side.toLowerCase()} ${line.kind}`}>
      <span className="ln">{number ?? ''}</span>
      {number !== null ? gutterButton(number, side) : null}
      <span className="lc">{index >= 0 ? contentFor(line, index) : line.text || ' '}</span>
    </div>
  )
}
