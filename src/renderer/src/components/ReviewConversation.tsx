import React, { useMemo, useState } from 'react'
import type { AddReviewCommentInput, ReviewComment, ReviewSnapshot, SubmitReviewEvent } from '@shared/review'

function statusTone(value?: string): string {
  const upper = value?.toUpperCase() ?? ''
  if (upper.includes('APPROV') || upper === 'PASS' || upper === 'SUCCESS') return 'success'
  if (upper.includes('CHANGE') || upper === 'FAIL' || upper === 'FAILURE' || upper === 'ERROR') return 'danger'
  if (upper === 'PENDING' || upper === 'QUEUED' || upper === 'IN_PROGRESS') return 'warning'
  return 'neutral'
}

function CommentCard({
  comment,
  providerLabel,
  canReply,
  onReply,
  onDelete
}: {
  comment: ReviewComment
  providerLabel: string
  canReply: boolean
  onReply: (commentId: string, body: string) => Promise<void>
  onDelete: (commentId: string) => Promise<void>
}): React.JSX.Element {
  const [replying, setReplying] = useState(false)
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <article className={`review-comment-card ${comment.source}`}>
      <header>
        <span className="review-avatar">{comment.author.login.slice(0, 1).toUpperCase()}</span>
        <span><strong>{comment.author.login}</strong><small>{new Date(comment.createdAt).toLocaleString()}</small></span>
        <span className={`review-status ${comment.source === 'local' ? 'warning' : 'neutral'}`}>{comment.source === 'local' ? 'Local' : providerLabel}</span>
      </header>
      {comment.file ? <div className="review-comment-location">{comment.file}{comment.line ? `:${comment.line}` : ''}{comment.side ? ` · ${comment.side === 'RIGHT' ? 'new' : 'old'} side` : ''}</div> : null}
      {comment.diffHunk ? <pre className="review-comment-hunk">{comment.diffHunk}</pre> : null}
      <p>{comment.body}</p>
      <footer>
        {comment.url ? <button className="btn-ghost" onClick={() => void window.boss.openExternal(comment.url!)}>Open on {providerLabel}</button> : null}
        {canReply && comment.source === 'remote' && comment.file ? <button className="btn-ghost" onClick={() => setReplying((value) => !value)}>Reply</button> : null}
        {comment.canDelete ? <button className="btn-ghost danger" onClick={() => void onDelete(comment.id)}>Delete local note</button> : null}
      </footer>
      {replying ? <div className="review-reply-composer">
        <textarea rows={3} value={reply} onChange={(event) => setReply(event.target.value)} placeholder={`Reply on ${providerLabel}…`} autoFocus />
        <div><button className="btn-deny" onClick={() => setReplying(false)}>Cancel</button><button className="btn-allow" disabled={!reply.trim() || busy} onClick={() => {
          setBusy(true)
          void onReply(comment.id, reply.trim())
            .then(() => { setReply(''); setReplying(false) })
            .catch(() => { /* The parent surfaces the error; retain the draft. */ })
            .finally(() => setBusy(false))
        }}>Publish reply</button></div>
      </div> : null}
    </article>
  )
}

export function ReviewConversation({
  snapshot,
  loading,
  error,
  onRefresh,
  onAddComment,
  onReply,
  onDelete,
  onSubmit
}: {
  snapshot: ReviewSnapshot | null
  loading: boolean
  error: string
  onRefresh: () => void
  onAddComment: (input: AddReviewCommentInput, publish: boolean) => Promise<void>
  onReply: (commentId: string, body: string) => Promise<void>
  onDelete: (commentId: string) => Promise<void>
  onSubmit: (event: SubmitReviewEvent, body: string) => Promise<void>
}): React.JSX.Element {
  const [body, setBody] = useState('')
  const [reviewBody, setReviewBody] = useState('')
  const [busy, setBusy] = useState(false)
  const comments = useMemo(() => [
    ...(snapshot?.changeRequest?.comments ?? []),
    ...(snapshot?.localComments ?? [])
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt)), [snapshot])
  const changeRequest = snapshot?.changeRequest
  const provider = snapshot?.provider
  const providerLabel = provider?.label ?? 'remote'

  const submitComment = async (publish: boolean): Promise<void> => {
    if (!body.trim()) return
    setBusy(true)
    try {
      await onAddComment({ body: body.trim() }, publish)
      setBody('')
    } catch {
      // The parent surfaces the error; retain the draft so it can be retried.
    } finally { setBusy(false) }
  }
  const submitReview = async (event: SubmitReviewEvent): Promise<void> => {
    setBusy(true)
    try {
      await onSubmit(event, reviewBody.trim())
      setReviewBody('')
    } catch {
      // The parent surfaces the error; retain the draft so it can be retried.
    } finally { setBusy(false) }
  }

  return <div className="review-conversation">
    <div className="review-conversation-head">
      <div><strong>{changeRequest ? `${changeRequest.displayId} ${changeRequest.title}` : 'Review notes'}</strong><small>{provider?.label ?? 'Local Git'} · {snapshot?.branch || 'detached HEAD'}</small></div>
      {changeRequest ? <button className="btn-ghost" onClick={() => void window.boss.openExternal(changeRequest.url)}>Open {provider?.changeRequestLabel ?? 'review'} ↗</button> : null}
      <button className="btn-ghost" disabled={loading} onClick={onRefresh}>{loading ? 'Syncing…' : 'Refresh'}</button>
    </div>
    {error || snapshot?.syncError ? <div className="review-sync-error">{error || snapshot?.syncError}</div> : null}
    {changeRequest ? <section className="review-pr-summary">
      <div className="review-pr-badges"><span className={`review-status ${changeRequest.isDraft ? 'warning' : statusTone(changeRequest.state)}`}>{changeRequest.isDraft ? 'Draft' : changeRequest.state}</span>{changeRequest.reviewDecision ? <span className={`review-status ${statusTone(changeRequest.reviewDecision)}`}>{changeRequest.reviewDecision.replaceAll('_', ' ')}</span> : null}{changeRequest.mergeStateStatus ? <span className={`review-status ${statusTone(changeRequest.mergeStateStatus)}`}>{changeRequest.mergeStateStatus.replaceAll('_', ' ')}</span> : null}</div>
      <div className="review-pr-refs"><code>{changeRequest.headRefName}</code><span>→</span><code>{changeRequest.baseRefName}</code></div>
      {changeRequest.checks.length ? <div className="review-checks">{changeRequest.checks.map((check) => <button key={`${check.name}-${check.state}`} className={`review-check ${statusTone(check.bucket ?? check.state)}`} onClick={() => check.url && void window.boss.openExternal(check.url)} disabled={!check.url}><span />{check.name}<small>{check.state}</small></button>)}</div> : null}
      {changeRequest.reviews.length ? <div className="review-reviewers">{changeRequest.reviews.map((review) => <div key={review.id}><span className="review-avatar">{review.author.login.slice(0, 1).toUpperCase()}</span><span><strong>{review.author.login}</strong><small>{review.state.replaceAll('_', ' ')}</small></span>{review.body ? <p>{review.body}</p> : null}</div>)}</div> : null}
    </section> : <div className="review-local-explainer">{provider ? `No ${provider.changeRequestLabel.toLowerCase()} is attached to this branch.` : 'No remote review provider is configured for this checkout.'} Local annotations still work and remain on this machine.</div>}
    <section className="review-thread">
      {comments.map((comment) => <CommentCard key={`${comment.source}-${comment.id}`} comment={comment} providerLabel={providerLabel} canReply={Boolean(changeRequest && provider?.capabilities.replyToComment)} onReply={onReply} onDelete={onDelete} />)}
      {!loading && !comments.length ? <div className="empty-inline">No review comments yet.</div> : null}
    </section>
    <section className="review-compose">
      <textarea rows={3} value={body} onChange={(event) => setBody(event.target.value)} placeholder="Add an overall review note…" />
      <div><button className="btn-ghost" disabled={!body.trim() || busy} onClick={() => void submitComment(false)}>Save local note</button>{changeRequest && provider?.capabilities.publishOverallComment ? <button className="btn-allow" disabled={!body.trim() || busy} onClick={() => void submitComment(true)}>Publish to {provider.label}</button> : null}</div>
    </section>
    {changeRequest && provider?.capabilities.submitVerdict ? <section className="review-submit"><strong>Submit review</strong><textarea rows={3} value={reviewBody} onChange={(event) => setReviewBody(event.target.value)} placeholder="Review summary (required for requesting changes)…" /><div><button className="btn-ghost" disabled={busy} onClick={() => void submitReview('COMMENT')}>Comment</button><button className="btn-ghost success" disabled={busy} onClick={() => void submitReview('APPROVE')}>Approve</button><button className="btn-ghost danger" disabled={!reviewBody.trim() || busy} onClick={() => void submitReview('REQUEST_CHANGES')}>Request changes</button></div></section> : null}
  </div>
}
