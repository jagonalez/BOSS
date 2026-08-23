import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SessionInfo } from '@shared/opencode'
import type { ChangeRequestSummary } from '@shared/review'
import { BranchIcon, ExternalIcon, FolderIcon, ForkIcon, ReviewIcon } from './icons'

/** Pull request lookups already made.
 *
 *  The main process caches these too, and that is the cache that matters. This
 *  one only stops a second hover from crossing the IPC boundary again, which
 *  would otherwise re-render the card for an answer it already had.
 *
 *  Entries expire on the same horizon as the main process's, because they used
 *  to expire never: hovering a thread before its pull request existed cached
 *  the "none" answer for the lifetime of the app, and opening one afterwards
 *  could not dislodge it. */
const LOOKUP_TTL_MS = 60_000
const lookups = new Map<string, { at: number; changeRequest: ChangeRequestSummary | null }>()

function cachedLookup(key: string | undefined): ChangeRequestSummary | null | undefined {
  if (!key) return undefined
  const entry = lookups.get(key)
  if (!entry) return undefined
  if (Date.now() - entry.at >= LOOKUP_TTL_MS) {
    lookups.delete(key)
    return undefined
  }
  return entry.changeRequest
}

function rememberLookup(key: string, changeRequest: ChangeRequestSummary | null): void {
  lookups.set(key, { at: Date.now(), changeRequest })
}

function directoryLabel(path: string | undefined): string | undefined {
  if (!path) return undefined
  const home = '/Users/'
  if (!path.startsWith(home)) return path
  const rest = path.slice(home.length)
  const cut = rest.indexOf('/')
  return cut < 0 ? path : `~${rest.slice(cut)}`
}

function projectName(path: string | undefined): string | undefined {
  return path?.split('/').filter(Boolean).pop()
}

/** What a thread is working on, shown when the pointer rests on its row.
 *
 *  The branch is the thing worth surfacing: it decides what the review tab
 *  shows and where a terminal opens, and forgetting a thread was on a worktree
 *  makes correct behaviour look broken. */
export function ThreadCard({
  session,
  origin,
  at
}: {
  session: SessionInfo
  /** The thread this one was forked from, if it was. */
  origin?: string
  /** Where to put it, in viewport coordinates. */
  at: { top: number; left: number }
}): React.JSX.Element | null {
  const path = session.executionPath ?? session.projectPath ?? session.directory ?? session.path
  const branch = session.worktree?.branch
  // Keyed on the checkout alone, because the checkout is what decides the
  // answer: the snapshot reads the branch with git rather than trusting the
  // thread's record, so two threads sharing a path share a pull request.
  const key = path && session.worktree?.status !== 'removed' ? path : undefined
  const [changeRequest, setChangeRequest] = useState<ChangeRequestSummary | null | undefined>(
    () => cachedLookup(key)
  )

  useEffect(() => {
    // Any live checkout gets a lookup, not just a worktree one. The branch is
    // resolved by the snapshot itself, so gating on the thread's stored
    // worktree only ever hid pull requests that were really there — a thread
    // handed off from another workflow keeps its checkout but not always the
    // record, and a branch checked out by hand never had one. A checkout with
    // no pull request answers awaitingChangeRequest and renders nothing, which
    // is what the main checkout did before.
    if (!key) return
    const cached = cachedLookup(key)
    if (cached !== undefined) {
      setChangeRequest(cached)
      return
    }
    let live = true
    void window.boss.reviewSnapshot(key)
      .then((snapshot) => {
        const found = snapshot.changeRequest ?? null
        rememberLookup(key, found)
        if (live) setChangeRequest(found)
      })
      // A thread whose checkout has gone is not worth complaining about here.
      .catch(() => rememberLookup(key, null))
    return () => { live = false }
  }, [key])

  const project = projectName(session.projectPath ?? session.directory ?? session.path)
  const directory = directoryLabel(path)

  return createPortal(
    <div
      className="thread-card"
      role="tooltip"
      style={{ top: at.top, left: at.left }}
      // The card renders through a portal but stays a React child of the row,
      // so clicks still bubble to it and would select the thread. Nothing in
      // the card means "open this thread".
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
    >
      <strong className="thread-card-title">{session.title || 'Untitled'}</strong>

      <dl className="thread-card-facts">
        {project ? (
          <div>
            <dt title="Project"><FolderIcon size={14} /></dt>
            <dd>{project}{directory ? <code>{directory}</code> : null}</dd>
          </div>
        ) : null}
        <div>
          <dt title={session.worktree ? 'Worktree branch' : 'Branch'}><BranchIcon size={14} /></dt>
          <dd>
            <code className="thread-card-branch">{branch ?? 'main checkout'}</code>
            {session.worktree ? <span className="thread-card-tag">worktree</span> : null}
          </dd>
        </div>
        {origin ? (
          <div>
            <dt title="Forked from"><ForkIcon size={14} /></dt>
            <dd><code>{origin.slice(0, 12)}</code></dd>
          </div>
        ) : null}
      </dl>

      {changeRequest ? (
        <button
          className="thread-card-pr"
          onClick={(event) => {
            event.stopPropagation()
            void window.boss.openExternal(changeRequest.url)
          }}
        >
          <ReviewIcon size={14} />
          <span className="thread-card-pr-id">{changeRequest.displayId}</span>
          <span className="thread-card-pr-title">{changeRequest.title}</span>
          <ExternalIcon size={13} />
        </button>
      ) : null}
    </div>,
    document.body
  )
}
