import React, { useEffect, useRef, useState } from 'react'
import { useStore, appStore } from '../state/AppState'
import { parseGitDiff } from '../lib/diff'
import {
  gitBranches,
  gitChangedBetween,
  gitCheckout,
  gitCommitFiles,
  gitCreateBranch,
  gitCurrentBranch,
  gitDiffFiles,
  gitFileDiff,
  gitLog,
  gitShow,
  gitStatusFiles,
  gitStashPop,
  gitStashPush,
  planBranchSwitch
} from '../lib/git'
import { markStaleReviews, runCheckoutReview } from '../lib/actions'
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

export function GitView({
  contextPath,
  sessionId,
  groupId,
  reviewTabId
}: {
  contextPath?: string
  sessionId?: string
  groupId: string
  reviewTabId: string
}): React.JSX.Element {
  const projectRoot = useStore(appStore, (s) => s.projectPath)
  const projectPath = contextPath || projectRoot
  const gitRefresh = useStore(appStore, (s) => s.gitRefresh)
  const activeSessionId = sessionId
  const reviews = useStore(appStore, (s) => (activeSessionId ? s.sessionMeta[activeSessionId]?.reviews ?? [] : []))
  const [scope, setScope] = useState<Scope>('worktree')
  const [branches, setBranches] = useState<string[]>([])
  const [current, setCurrent] = useState('')
  const [branchBusy, setBranchBusy] = useState(false)
  const [branchError, setBranchError] = useState('')
  const [creatingBranch, setCreatingBranch] = useState(false)
  const [newBranchName, setNewBranchName] = useState('')
  const [baseBranch, setBaseBranch] = useState('origin/main')
  const [commits, setCommits] = useState<Array<{ sha: string; msg: string }>>([])
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null)
  const [data, setData] = useState<DiffFileData[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [reviewSnapshot, setReviewSnapshot] = useState<ReviewSnapshot | null>(null)
  const [reviewLoading, setReviewLoading] = useState(false)
  const [reviewError, setReviewError] = useState('')
  const [creatingChangeRequest, setCreatingChangeRequest] = useState(false)
  const [createChangeRequestError, setCreateChangeRequestError] = useState('')
  const reviewRequest = useRef(0)
  const scopeRequest = useRef(0)
  const branchBusyRef = useRef(false)
  const visibleComments = scope === 'change-request'
    ? [...(reviewSnapshot?.changeRequest?.comments ?? []), ...(reviewSnapshot?.localComments ?? [])]
    : reviewSnapshot?.localComments ?? []

  async function loadReview(): Promise<void> {
    if (!projectPath) return
    const request = ++reviewRequest.current
    setReviewLoading(true)
    setReviewError('')
    try {
      const snapshot = await window.boss.reviewSnapshot(projectPath)
      if (request === reviewRequest.current) setReviewSnapshot(snapshot)
    } catch (err) {
      if (request === reviewRequest.current) setReviewError(String((err as Error).message ?? err))
    } finally {
      if (request === reviewRequest.current) setReviewLoading(false)
    }
  }

  async function createChangeRequest(): Promise<void> {
    if (!projectPath || creatingChangeRequest) return
    setCreatingChangeRequest(true)
    setCreateChangeRequestError('')
    try {
      // Title and body are left to the forge, which fills them from the commits on the branch.
      // Writing them here would mean a compose form, and the commits already say it.
      await window.boss.reviewCreateChangeRequest(projectPath, {})
      // The snapshot is what draws the row, and it has just become wrong.
      await loadReview()
    } catch (err) {
      setCreateChangeRequestError(String((err as Error).message ?? err))
    } finally {
      setCreatingChangeRequest(false)
    }
  }

  useEffect(() => { void loadReview() }, [projectPath, gitRefresh])

  useEffect(() => {
    void (async () => {
      if (!projectPath) return
      try {
        const [list, branch] = await Promise.all([gitBranches(projectPath), gitCurrentBranch(projectPath)])
        setCurrent(branch)
        setBranches([...list, branch].filter(Boolean))
        if (!list.includes('origin/main')) setBaseBranch(branch || 'origin/main')
      } catch {
        setBranches([])
      }
    })()
  }, [projectPath])

  const refreshBranchData = (): void => {
    // The scope diff and the review snapshot both describe the checkout that
    // just changed underneath them; the current branch drives loadScope.
    void loadScope()
    void loadReview()
  }

  async function branchSwitchPlan(target: string): Promise<ReturnType<typeof planBranchSwitch>> {
    if (!projectPath) throw new Error('No checkout is available')
    const files = await gitStatusFiles(projectPath)
    const local = files
      .filter((file) => !file.untracked)
      .flatMap((file) => file.oldPath ? [file.oldPath, file.path] : [file.path])
    const untracked = files.filter((file) => file.untracked).map((file) => file.path)
    return planBranchSwitch(local, untracked, await gitChangedBetween(projectPath, `HEAD..${target}`))
  }

  async function performSwitch(target: string, expectedStash: boolean): Promise<void> {
    let checkedOut = false
    let stashOid: string | null = null
    const latest = await branchSwitchPlan(target)
    if (latest.action === 'block') {
      throw new Error(`The checkout changed while this switch was pending. Conflicting paths: ${latest.conflicts?.join(', ')}`)
    }
    if (!expectedStash && latest.action !== 'direct') {
      throw new Error('The working tree changed while the branch switch was being prepared. Choose the branch again to review the updated plan.')
    }
    const shouldStash = expectedStash && latest.action === 'stash'
    try {
      if (shouldStash) stashOid = await gitStashPush(projectPath)
      try {
        await gitCheckout(projectPath, target)
        checkedOut = true
      } catch (err) {
        if (stashOid) {
          try {
            await gitStashPop(projectPath, stashOid)
          } catch (restoreError) {
            throw new Error(`${String((err as Error).message ?? err)} Restoring BOSS stash ${stashOid.slice(0, 12)} also failed: ${String((restoreError as Error).message ?? restoreError)}`)
          }
        }
        throw err
      }
      // A no-op push returns no oid, so it must never pop the user's existing
      // top stash. When a stash exists, resolve that captured commit exactly.
      if (stashOid) await gitStashPop(projectPath, stashOid)
      setCurrent(await gitCurrentBranch(projectPath))
      refreshBranchData()
    } catch (err) {
      // Checkout may have succeeded before stash restoration failed. Reflect
      // the actual branch and conflicted worktree instead of leaving old data.
      if (checkedOut) {
        try {
          setCurrent(await gitCurrentBranch(projectPath))
          refreshBranchData()
        } catch { /* preserve the original switch error */ }
      }
      throw err
    }
  }

  async function switchTo(target: string, stash: boolean): Promise<void> {
    if (!projectPath || branchBusyRef.current) return
    branchBusyRef.current = true
    setBranchBusy(true)
    setBranchError('')
    try {
      await performSwitch(target, stash)
    } catch (err) {
      setBranchError(String((err as Error).message ?? err))
    } finally {
      branchBusyRef.current = false
      setBranchBusy(false)
    }
  }

  async function requestSwitch(target: string): Promise<void> {
    if (!projectPath || !target || target === current || branchBusyRef.current) return
    branchBusyRef.current = true
    setBranchBusy(true)
    setBranchError('')
    try {
      const plan = await branchSwitchPlan(target)
      if (plan.action === 'direct') {
        await performSwitch(target, false)
        return
      }
      if (plan.action === 'block') {
        appStore.setState({
          confirm: {
            title: `Can't switch to ${target}`,
            message: `These files differ on ${target} and also have local changes, so a stash would not survive the trip: ${plan.conflicts?.join(', ')}. Commit or stash them yourself first.`,
            confirmLabel: 'Stay',
            notice: true,
            action: () => {}
          }
        })
        return
      }
      appStore.setState({
        confirm: {
          title: `Switch to ${target}?`,
          message: 'Your working tree has local changes. They will be stashed before the switch and restored after it.',
          confirmLabel: 'Stash & switch',
          action: () => void switchTo(target, true)
        }
      })
    } catch (err) {
      setBranchError(String((err as Error).message ?? err))
    } finally {
      branchBusyRef.current = false
      setBranchBusy(false)
    }
  }

  async function createBranch(): Promise<void> {
    const name = newBranchName.trim()
    if (!projectPath || !name || branchBusyRef.current) return
    branchBusyRef.current = true
    setBranchBusy(true)
    setBranchError('')
    try {
      await gitCreateBranch(projectPath, name)
      setCreatingBranch(false)
      setNewBranchName('')
      const [list, branch] = await Promise.all([gitBranches(projectPath), gitCurrentBranch(projectPath)])
      setCurrent(branch)
      setBranches([...list, branch].filter(Boolean))
      refreshBranchData()
    } catch (err) {
      setBranchError(String((err as Error).message ?? err))
    } finally {
      branchBusyRef.current = false
      setBranchBusy(false)
    }
  }

  useEffect(() => {
    if (scope !== 'commits' && scope !== 'conversation') void loadScope()
  }, [projectPath, scope, baseBranch, current, gitRefresh, reviewSnapshot?.changeRequest?.headRefOid])

  useEffect(() => {
    if (activeSessionId) markStaleReviews(activeSessionId, projectPath)
  }, [activeSessionId, gitRefresh, projectPath])

  async function loadScope(): Promise<void> {
    const request = ++scopeRequest.current
    setError('')
    setData([])
    if (!projectPath) return
    setLoading(true)
    try {
      const changeRequestFiles = scope === 'change-request' && reviewSnapshot?.changeRequest
        ? await window.boss.reviewChangeRequestDiff(projectPath)
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
      if (request === scopeRequest.current) setData(items)
    } catch (err) {
      if (request === scopeRequest.current) setError(String((err as Error).message ?? err))
    }
    if (request === scopeRequest.current) setLoading(false)
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
      if (publish) setReviewSnapshot(await window.boss.reviewPublishComment(projectPath, input))
      else {
        await window.boss.reviewLocalAdd(projectPath, input)
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
      setReviewSnapshot(await window.boss.reviewReply(projectPath, commentId, body))
    } catch (err) {
      setReviewError(String((err as Error).message ?? err))
      throw err
    }
  }

  async function deleteLocalComment(commentId: string): Promise<void> {
    await window.boss.reviewLocalDelete(projectPath, commentId)
    await loadReview()
  }

  async function submitReview(event: SubmitReviewEvent, body: string): Promise<void> {
    setReviewError('')
    try {
      setReviewSnapshot(await window.boss.reviewSubmit(projectPath, event, body))
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
        {projectPath && scope !== 'conversation' ? (
          <div className="git-branch" title="Local branches">
            <span className={`git-branch-current ${branchBusy ? 'busy' : ''}`}>⎇ {current || '—'}</span>
            <select
              aria-label="Switch branch"
              value={current}
              disabled={branchBusy || branches.length === 0}
              onChange={(e) => void requestSwitch(e.target.value)}
            >
              {branches.map((b) => (
                <option key={b} value={b} className={b === current ? 'current' : ''}>
                  {b === current ? `${b} (current)` : b}
                </option>
              ))}
            </select>
            <button
              className="btn-ghost git-branch-new"
              onClick={() => setCreatingBranch((open) => !open)}
              disabled={branchBusy}
            >
              + New
            </button>
            {creatingBranch ? (
              <input
                className="git-branch-name"
                placeholder="New branch from HEAD"
                value={newBranchName}
                onChange={(e) => setNewBranchName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void createBranch()
                  if (e.key === 'Escape') setCreatingBranch(false)
                }}
                autoFocus
                spellCheck={false}
              />
            ) : null}
          </div>
        ) : null}
        {projectPath && scope !== 'conversation' ? (
          <button
            className="btn-ghost"
            onClick={() => {
              setError('')
              void runCheckoutReview(
                groupId,
                reviewTabId,
                SCOPE_LABELS[scope] + (scope === 'compare' ? ` vs ${baseBranch}` : ''),
                projectPath,
                activeSessionId
              ).catch((err) => setError(String((err as Error).message ?? err)))
            }}
            title="Run an agent review in this checkout"
          >
            <ReviewIcon size={14} /> Run review
          </button>
        ) : null}
      </div>
      {branchError ? <div className="review-sync-error">{branchError}</div> : null}
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
      {reviewSnapshot?.provider && !reviewSnapshot.changeRequest && reviewSnapshot.awaitingChangeRequest ? (
        <div className="review-sync-note">
          <span>
            No {reviewSnapshot.provider.label} {reviewSnapshot.provider.changeRequestLabel.toLowerCase()} for this branch
            yet. Comments are saved here until you open one.
          </span>
          {reviewSnapshot.provider.capabilities.createChangeRequest ? (
            <button className="btn-ghost" disabled={creatingChangeRequest} onClick={() => void createChangeRequest()}>
              {creatingChangeRequest ? 'Opening…' : `Open ${reviewSnapshot.provider.changeRequestLabel.toLowerCase()}`}
            </button>
          ) : null}
        </div>
      ) : null}
      {createChangeRequestError ? <div className="review-sync-error">{createChangeRequestError}</div> : null}
      {reviewSnapshot?.provider && !reviewSnapshot.changeRequest && reviewSnapshot.syncError ? (
        <div className="review-sync-error">{reviewSnapshot.syncError} Remote publishing is unavailable for this checkout; local notes still work.</div>
      ) : null}
      {reviewSnapshot?.changeRequest && scope !== 'change-request' && scope !== 'conversation' ? (
        <div className="review-publish-hint">Publish inline comments to {reviewSnapshot.provider?.label ?? 'the remote'} from the Change request view. This view saves checkout-local notes.</div>
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
