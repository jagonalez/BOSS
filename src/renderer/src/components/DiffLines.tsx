import React from 'react'
import type { DiffLine } from '../lib/diff'
import { langForPath, highlightCode } from '../lib/highlight'
import type { AddReviewCommentInput, ReviewComment, ReviewProviderSummary } from '@shared/review'

export function DiffLines({
  lines,
  path,
  comments = [],
  provider,
  canPublish = false,
  onAddComment
}: {
  lines: DiffLine[]
  path?: string
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

  return (
    <div className="diff-view">
      {lines.map((line, i) => {
        const markup = highlighted?.[i]
        const content: React.ReactNode = markup
          ? <code dangerouslySetInnerHTML={{ __html: markup }} />
          : line.text || ' '
        const number = line.kind === 'del' ? line.oldNo : line.newNo
        const side = line.kind === 'del' ? 'LEFT' : 'RIGHT'
        const lineComments = number === null ? [] : byLine.get(`${side}:${number}`) ?? []
        const isCommenting = number !== null && commenting?.line === number && commenting.side === side
        return <React.Fragment key={i}>
          <div className={`diff-line ${line.kind} ${lineComments.length ? 'has-comments' : ''}`}>
            <span className="ln">{number ?? ''}</span>
            {onAddComment && number !== null && line.kind !== 'hunk' ? (
              <button
                className="diff-comment-add"
                title={`Comment on ${side === 'RIGHT' ? 'new' : 'old'} line ${number}`}
                onClick={() => {
                  setCommenting(isCommenting ? null : { line: number, side })
                  setBody('')
                }}
              >+
              </button>
            ) : null}
            <span className="lc">{content}</span>
          </div>
          {lineComments.map((comment) => (
            <div className={`diff-inline-comment ${comment.source}`} key={`${comment.source}-${comment.id}`}>
              <span className="review-avatar">{comment.author.login.slice(0, 1).toUpperCase()}</span>
              <span><strong>{comment.author.login}</strong><small>{comment.source === 'local' ? 'Local note' : provider?.label ?? 'Remote'} · {new Date(comment.createdAt).toLocaleString()}</small><p>{comment.body}</p></span>
            </div>
          ))}
          {isCommenting ? (
            <div className="diff-comment-composer">
              <textarea value={body} onChange={(event) => setBody(event.target.value)} placeholder={`Comment on ${path}:${number}`} autoFocus rows={3} />
              <div>
                <button className="btn-deny" onClick={() => setCommenting(null)}>Cancel</button>
                <button className="btn-ghost" disabled={!body.trim() || saving} onClick={() => void save(false)}>Save local note</button>
                {canPublish && provider?.capabilities.publishInlineComment ? <button className="btn-allow" disabled={!body.trim() || saving} onClick={() => void save(true)}>Publish to {provider.label}</button> : null}
              </div>
            </div>
          ) : null}
        </React.Fragment>
      })}
    </div>
  )
}
