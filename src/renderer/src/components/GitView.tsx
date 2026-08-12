import React, { useEffect, useState } from 'react'
import { useStore, appStore } from '../state/AppState'
import { parseGitDiff } from '../lib/diff'
import { gitBranches, gitCommitFiles, gitCurrentBranch, gitDiffFiles, gitFileDiff, gitLog, gitShow } from '../lib/git'
import { markStaleReviews, runThreadReview } from '../lib/actions'
import { DiffReview, type DiffFileData } from './DiffReview'
import { ReviewIcon } from './icons'
import type { AddReviewCommentInput, ReviewSnapshot, SubmitReviewEvent } from '@shared/review'
import { ReviewConversation } from './ReviewConversation'

type Scope = 'worktree' | 'staged' | 'compare' | 'commits' | 'change-request' | 'conversation'

const SCOPE_LABELS: Record<Scope, string> = {
  worktree: 'Working tree',
  staged: 'Staged',
  compare: 'Compare',
  commits: 'Commits',
  'change-request': 'Change request',
  conversation: 'Conversation'
}

export function GitView({ contextPath, sessionId }: { contextPath?: string; sessionId?: string }): React.JSX.Element {
  const projectRoot = useStore(appStore, (s) => s.projectPath)
  const projectPath = contextPath || projectRoot
  const gitRefresh = useStore(appStore, (s) => s.gitRefresh)
  const activeSessionId = sessionId
  const reviews = useStore(appStore, (s) => (activeSessionId ? s.sessionMeta[activeSessionId]?.reviews ?? [] : []))
  const [scope, setScope] = useState<Scope>('worktree')
  const [branches, setBranches] = useState<string[]>([])
  const [baseBranch, setBaseBranch] = useState('origin/main')
  const [commits, setCommits] = useState<Array<{ sha: string; msg: string }>>([])
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null)
  const [data, setData] = useState<DiffFileData[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [reviewSnapshot, setReviewSnapshot] = useState<ReviewSnapshot | null>(null)
  const [reviewLoading, setReviewLoading] = useState(false)
  const [reviewError, setReviewError] = useState('')
  const visibleComments = scope === 'change-request'
    ? [...(reviewSnapshot?.changeRequest?.comments ?? []), ...(reviewSnapshot?.localComments ?? [])]
    : reviewSnapshot?.localComments ?? []

  async function loadReview(): Promise<void> {
    if (!projectPath) return
    setReviewLoading(true)
    setReviewError('')
    try {
      setReviewSnapshot(await window.ralf.reviewSnapshot(projectPath))
    } catch (err) {
      setReviewError(String((err as Error).message ?? err))
    } finally {
      setReviewLoading(false)
    }
  }

  useEffect(() => { void loadReview() }, [projectPath, gitRefresh])

  useEffect(() => {
    void (async () => {
      if (!projectPath) return
      try {
        const list = await gitBranches(projectPath)
        const current = await gitCurrentBranch(projectPath)
        setBranches([...list, current].filter(Boolean))
        if (!list.includes('origin/main')) setBaseBranch(current || 'origin/main')
      } catch {
        setBranches([])
      }
    })()
  }, [projectPath])

  useEffect(() => {
    if (scope !== 'commits' && scope !== 'conversation') void loadScope()
  }, [projectPath, scope, baseBranch, gitRefresh, reviewSnapshot?.changeRequest?.headRefOid])

  useEffect(() => {
    if (activeSessionId) markStaleReviews(activeSessionId, projectPath)
  }, [activeSessionId, gitRefresh, projectPath])

  async function loadScope(): Promise<void> {
    setError('')
    setData([])
    if (!projectPath) return
    setLoading(true)
    try {
      const changeRequestFiles = scope === 'change-request' && reviewSnapshot?.changeRequest
        ? await window.ralf.reviewChangeRequestDiff(projectPath)
        : undefined
      const paths = changeRequestFiles?.map((file) => file.path)
        ?? await gitDiffFiles(projectPath, scope as 'worktree' | 'staged' | 'compare', baseBranch)
      const items: DiffFileData[] = []
      for (const p of paths) {
        try {
          const text = changeRequestFiles
            ? changeRequestFiles.find((file) => file.path === p)?.patch ?? ''
            : await gitFileDiff(projectPath, scope as 'worktree' | 'staged' | 'compare', p, baseBranch)
          const lines = parseGitDiff(text)
          items.push({
            path: p,
            additions: lines.filter((l) => l.kind === 'add').length,
            deletions: lines.filter((l) => l.kind === 'del').length,
            lines
          })
        } catch {
          /* skip unparseable */
        }
      }
      setData(items)
    } catch (err) {
      setError(String((err as Error).message ?? err))
    }
    setLoading(false)
  }

  useEffect(() => {
    void (async () => {
      if (scope !== 'commits') return
      setLoading(true)
      setError('')
      try {
        setCommits(await gitLog(projectPath))
      } catch (err) {
        setError(String((err as Error).message ?? err))
      }
      setLoading(false)
    })()
  }, [projectPath, scope])

  async function selectCommit(sha: string): Promise<void> {
    setSelectedCommit(sha)
    setLoading(true)
    setError('')
    setData([])
    try {
      const paths = await gitCommitFiles(projectPath, sha)
      const items: DiffFileData[] = []
      for (const p of paths) {
        try {
          const text = await gitShow(projectPath, sha, p)
          const lines = parseGitDiff(text)
          items.push({
            path: p,
            additions: lines.filter((l) => l.kind === 'add').length,
            deletions: lines.filter((l) => l.kind === 'del').length,
            lines
          })
        } catch {
          /* skip */
        }
      }
      setData(items)
    } catch (err) {
      setError(String((err as Error).message ?? err))
    }
    setLoading(false)
  }

  async function addReviewComment(input: AddReviewCommentInput, publish: boolean): Promise<void> {
    setReviewError('')
    try {
      if (publish) setReviewSnapshot(await window.ralf.reviewPublishComment(projectPath, input))
      else {
        await window.ralf.reviewLocalAdd(projectPath, input)
        await loadReview()
      }
    } catch (err) {
      setReviewError(String((err as Error).message ?? err))
      throw err
    }
  }

  async function replyToComment(commentId: string, body: string): Promise<void> {
    setReviewError('')
    try {
      setReviewSnapshot(await window.ralf.reviewReply(projectPath, commentId, body))
    } catch (err) {
      setReviewError(String((err as Error).message ?? err))
      throw err
    }
  }

  async function deleteLocalComment(commentId: string): Promise<void> {
    await window.ralf.reviewLocalDelete(projectPath, commentId)
    await loadReview()
  }

  async function submitReview(event: SubmitReviewEvent, body: string): Promise<void> {
    setReviewError('')
    try {
      setReviewSnapshot(await window.ralf.reviewSubmit(projectPath, event, body))
    } catch (err) {
      setReviewError(String((err as Error).message ?? err))
      throw err
    }
  }

  return (
    <div className="git-view">
      <div className="git-toolbar">
        <div className="git-scope">
          {(Object.keys(SCOPE_LABELS) as Scope[]).filter((item) => item !== 'change-request' || reviewSnapshot?.changeRequest).map((s) => (
            <button key={s} className={`git-scope-btn ${scope === s ? 'active' : ''}`} onClick={() => setScope(s)}>
              {SCOPE_LABELS[s]}
            </button>
          ))}
        </div>
        {scope === 'compare' && (
          <select value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} title="Compare against">
            {branches.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        )}
        {activeSessionId && scope !== 'conversation' ? (
          <button
            className="btn-ghost"
            onClick={() =>
              void runThreadReview(
                activeSessionId,
                SCOPE_LABELS[scope] + (scope === 'compare' ? ` vs ${baseBranch}` : ''),
                projectPath
              )
            }
            title="Ask the agent to review the current changes in this thread"
          >
            <ReviewIcon size={14} /> Run review
          </button>
        ) : null}
      </div>
      {reviews.length > 0 ? (
        <div className="git-reviews">
          <span className="git-reviews-title">Reviews</span>
          {reviews.map((r) => (
            <span key={r.id} className={`git-review ${r.stale ? 'stale' : ''}`} title={`${r.target} — reviewed at ${r.baseSha.slice(0, 8)}`}>
              {r.target} · {new Date(r.createdAt).toLocaleTimeString()}
              {r.stale ? ' · stale' : ''}
            </span>
          ))}
        </div>
      ) : null}
      {scope === 'conversation' ? (
        <ReviewConversation
          snapshot={reviewSnapshot}
          loading={reviewLoading}
          error={reviewError}
          onRefresh={() => void loadReview()}
          onAddComment={addReviewComment}
          onReply={replyToComment}
          onDelete={deleteLocalComment}
          onSubmit={submitReview}
        />
      ) : scope === 'commits' ? (
        <div className="two-pane">
          <div className="pane pane-list">
            {commits.map((c) => (
              <button
                key={c.sha}
                className={`file-row git-commit ${selectedCommit === c.sha ? 'active' : ''}`}
                onClick={() => void selectCommit(c.sha)}
              >
                <span className="git-commit-sha">{c.sha.slice(0, 7)}</span>
                <span className="git-commit-msg">{c.msg}</span>
              </button>
            ))}
            {!loading && commits.length === 0 && <div className="empty-inline">{error || 'No commits'}</div>}
          </div>
          <DiffReview files={data} loading={loading} error={error} showList={false} comments={visibleComments} onAddComment={addReviewComment} />
        </div>
      ) : (
        <DiffReview files={data} loading={loading} error={error} comments={visibleComments} provider={reviewSnapshot?.provider} canPublish={scope === 'change-request'} onAddComment={addReviewComment} />
      )}
    </div>
  )
}
