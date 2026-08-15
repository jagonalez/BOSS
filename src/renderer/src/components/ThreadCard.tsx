import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SessionInfo } from '@shared/opencode'
import type { ChangeRequestSummary } from '@shared/review'
import { BranchIcon, ExternalIcon, FolderIcon, ForkIcon, ReviewIcon } from './icons'

/** How long the pointer rests on a row before the card appears.
 *
 *  Long: the card is big enough to cover the rows around it, so it has to be
 *  clearly asked for. Crossing the sidebar to reach something else, or pausing
 *  over a row while reading it, must not raise one. */
const HOVER_DELAY_MS = 900

/** Pull request lookups already made, kept for as long as the app runs.
 *
 *  The main process caches these too, and that is the cache that matters. This
 *  one only stops a second hover from crossing the IPC boundary again, which
 *  would otherwise re-render the card for an answer it already had. */
const lookups = new Map<string, ChangeRequestSummary | null>()

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
  const key = path && branch ? `${path} ${branch}` : undefined
  const [changeRequest, setChangeRequest] = useState<ChangeRequestSummary | null | undefined>(
    key ? lookups.get(key) : undefined
  )

  useEffect(() => {
    // Only worktree threads get a lookup. A thread on the main checkout is
    // usually on the default branch, where a pull request would be surprising.
    if (!key || !path || !branch || lookups.has(key)) return
    let live = true
    void window.boss.reviewSnapshot(path)
      .then((snapshot) => {
        const found = snapshot.changeRequest ?? null
        lookups.set(key, found)
        if (live) setChangeRequest(found)
      })
      // A thread whose checkout has gone is not worth complaining about here.
      .catch(() => lookups.set(key, null))
    return () => { live = false }
  }, [key, path, branch])

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

/** Show a card after the pointer rests on something.
 *
 *  Returns the props to spread on the row and whether the card is due. Keeping
 *  the timer here means the card itself never mounts until it is wanted, so a
 *  pull request is not looked up for every row the pointer crosses. */
export function useHoverCard(): {
  at: { top: number; left: number } | null
  handlers: { onMouseEnter: (event: React.MouseEvent<HTMLElement>) => void; onMouseLeave: () => void }
} {
  const [at, setAt] = useState<{ top: number; left: number } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clear = (): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }

  useEffect(() => clear, [])

  return {
    at,
    handlers: {
      onMouseEnter: (event) => {
        clear()
        // The sidebar clips its children and is narrower than the card, so the
        // card is placed against the viewport instead. Measured on enter: the
        // row cannot move while the pointer rests on it.
        const rect = event.currentTarget.getBoundingClientRect()
        timer.current = setTimeout(() => setAt({ top: rect.top, left: rect.right + 8 }), HOVER_DELAY_MS)
      },
      onMouseLeave: () => {
        clear()
        setAt(null)
      }
    }
  }
}
