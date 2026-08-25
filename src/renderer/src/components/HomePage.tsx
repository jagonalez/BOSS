import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SupervisedThread, SupervisionSnapshot, TranscriptSearchResult } from '@shared/supervision'
import { useStore, appStore } from '../state/AppState'
import { exportSessionMarkdown, newGlobalChat, openProject, openProjectFolder, selectSession, showPage } from '../lib/actions'
import { OpenCode } from '../lib/opencode'
import { projectName } from '../lib/project-name'
import { serviceDegradations } from '../lib/status'
import { ChatIcon, ChevronIcon, FolderIcon, LabMark, PlusIcon, SearchIcon } from './icons'

function timeAgo(timestamp?: number): string {
  if (!timestamp) return 'recently'
  const diff = Date.now() - timestamp
  if (diff < 60_000) return 'now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

async function openThread(thread: Pick<SupervisedThread, 'threadId' | 'projectPath'>): Promise<void> {
  if (thread.projectPath && thread.projectPath !== appStore.getState().projectPath) {
    await openProject(thread.projectPath)
  }
  selectSession(thread.threadId)
  void OpenCode.acknowledgeAttention(thread.threadId).catch(() => {})
}

function threadState(thread: SupervisedThread): { label: string; tone: 'attention' | 'running' | 'recent' } {
  if (thread.attention?.kind === 'permission') return { label: 'Needs permission', tone: 'attention' }
  if (thread.attention?.kind === 'question') return { label: 'Needs an answer', tone: 'attention' }
  if (thread.attention?.kind === 'error' || thread.lastRun?.status === 'error') return { label: 'Run failed', tone: 'attention' }
  if (thread.running) return { label: 'Working', tone: 'running' }
  if (thread.result?.changedFiles) {
    const files = thread.result.changedFiles
    return { label: `${files} file${files === 1 ? '' : 's'} changed`, tone: 'recent' }
  }
  return { label: 'Recently active', tone: 'recent' }
}

function ThreadRow({ thread, onCtx }: {
  thread: SupervisedThread
  onCtx: (event: React.MouseEvent, thread: SupervisedThread) => void
}): React.JSX.Element {
  const state = threadState(thread)
  return (
    <button
      className="home-thread-row"
      onClick={() => void openThread(thread)}
      onContextMenu={(event) => onCtx(event, thread)}
    >
      <span className={`home-thread-icon ${state.tone}`}><ChatIcon size={16} /></span>
      <span className="home-thread-copy">
        <strong>{thread.title}</strong>
        <span>{projectName(thread.projectPath)} · {thread.backendId}</span>
        {thread.result?.summary ? <small>{thread.result.summary}</small> : null}
      </span>
      <span className="home-thread-status">
        <strong>{state.label}</strong>
        <small>{timeAgo(thread.updatedAt)}</small>
      </span>
      <ChevronIcon size={16} />
    </button>
  )
}

function SearchResult({ result }: { result: TranscriptSearchResult }): React.JSX.Element {
  return (
    <button className="home-search-result" onClick={() => void openThread({
      threadId: result.threadId,
      projectPath: result.projectPath
    })}>
      <span className="home-search-result-meta">
        <strong>{result.title}</strong>
        <small>{projectName(result.projectPath)} · {result.backendId} · {result.kind} · {timeAgo(result.timestamp)}</small>
      </span>
      <span className="home-search-snippet">{result.snippet}</span>
      <ChevronIcon size={16} />
    </button>
  )
}

export function HomePage(): React.JSX.Element {
  const serverHealthy = useStore(appStore, (state) => state.serverHealthy)
  const serverUrl = useStore(appStore, (state) => state.serverUrl)
  const backends = useStore(appStore, (state) => state.backends)
  const projects = useStore(appStore, (state) => state.projects)
  const [snapshot, setSnapshot] = useState<SupervisionSnapshot | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<TranscriptSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [cardMenu, setCardMenu] = useState<{ x: number; y: number; thread: SupervisedThread } | null>(null)
  const cardMenuRef = useRef<HTMLDivElement>(null)
  const [cardMenuTop, setCardMenuTop] = useState<number | null>(null)
  const degradations = serviceDegradations(serverUrl, serverHealthy, backends)

  useEffect(() => {
    let disposed = false
    const refresh = (): void => {
      void OpenCode.supervision().then((value) => {
        if (!disposed) setSnapshot(value)
      }).catch(() => {})
    }
    refresh()
    const timer = window.setInterval(refresh, 5_000)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    const clean = query.trim()
    if (clean.length < 2) {
      setResults([])
      setSearching(false)
      return
    }
    setSearching(true)
    let disposed = false
    const timer = window.setTimeout(() => {
      void OpenCode.searchTranscripts(clean).then((value) => {
        if (!disposed) setResults(value)
      }).catch(() => {
        if (!disposed) setResults([])
      }).finally(() => {
        if (!disposed) setSearching(false)
      })
    }, 180)
    return () => {
      disposed = true
      window.clearTimeout(timer)
    }
  }, [query])

  useEffect(() => {
    if (!cardMenu) {
      setCardMenuTop(null)
      return
    }
    const height = cardMenuRef.current?.offsetHeight ?? 0
    const overflow = cardMenu.y + height - (window.innerHeight - 8)
    setCardMenuTop(overflow > 0 ? Math.max(8, cardMenu.y - overflow) : cardMenu.y)
  }, [cardMenu])

  useEffect(() => {
    if (!cardMenu) return
    const close = (): void => setCardMenu(null)
    const onDoc = (event: MouseEvent): void => {
      if (cardMenuRef.current && !cardMenuRef.current.contains(event.target as Node)) close()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [cardMenu])

  const recent = useMemo(
    () => (snapshot?.threads ?? []).filter((thread) => !thread.archived).slice(0, 8),
    [snapshot]
  )
  const running = (snapshot?.threads ?? []).filter((thread) => !thread.archived && thread.running).length
  const needsYou = (snapshot?.threads ?? []).filter((thread) =>
    thread.attention?.kind === 'permission'
    || thread.attention?.kind === 'question'
    || thread.attention?.kind === 'error'
    || thread.lastRun?.status === 'error'
  ).length
  const openCardMenu = useCallback((event: React.MouseEvent, thread: SupervisedThread): void => {
    event.preventDefault()
    event.stopPropagation()
    setCardMenu({ x: event.clientX, y: event.clientY, thread })
  }, [])

  return (
    <div className="product-page home-page">
      <header className="product-header">
        <div>
          <span className="product-eyebrow">Home</span>
          <h1>Pick up where you left off.</h1>
          <p>Continue recent work, start something new, or find anything across your BOSS history.</p>
        </div>
        {degradations.length ? (
          <div className="product-connection degraded" title={degradations.join('\n')}>
            <span />{degradations.length === 1 ? degradations[0] : `${degradations.length} services degraded`}
          </div>
        ) : null}
      </header>

      <div className="home-search">
        <SearchIcon size={17} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search messages, reasoning, and tool activity across every project…"
          aria-label="Search work history"
        />
        {searching ? <span>Searching…</span> : query.trim().length >= 2 ? <span>{results.length} results</span> : <kbd>⌘K</kbd>}
      </div>

      {query.trim().length >= 2 ? (
        <section className="product-section home-search-section">
          <div className="product-section-head"><h2>Work history</h2><span>{results.length}</span></div>
          <div className="product-list">
            {results.length > 0
              ? results.map((result) => <SearchResult key={`${result.threadId}:${result.messageId}:${result.kind}:${result.snippet}`} result={result} />)
              : <div className="product-empty">{searching ? 'Searching your work…' : 'No matching work found.'}</div>}
          </div>
        </section>
      ) : (
        <>
          <section className="home-actions" aria-label="Quick actions">
            <button onClick={() => void newGlobalChat()}>
              <span><PlusIcon size={18} /></span>
              <strong>New chat</strong>
              <small>Start with any agent</small>
            </button>
            <button onClick={() => void openProjectFolder()}>
              <span><FolderIcon size={18} /></span>
              <strong>Open project</strong>
              <small>Add a folder to BOSS</small>
            </button>
            <button onClick={() => showPage('lab-assistant')}>
              <span><LabMark size={18} /></span>
              <strong>Lab Assistant</strong>
              <small>Plan and orchestrate work</small>
            </button>
          </section>

          <div className="home-layout">
            <section className="product-section home-continue">
              <div className="product-section-head">
                <div><h2>Continue working</h2><p>Your most recently active threads across projects.</p></div>
                <span>{recent.length}</span>
              </div>
              <div className="product-list">
                {recent.length > 0
                  ? recent.map((thread) => <ThreadRow key={thread.threadId} thread={thread} onCtx={openCardMenu} />)
                  : <div className="product-empty">Start a chat or open a project to begin.</div>}
              </div>
            </section>

            <aside className="home-summary" aria-label="Workspace summary">
              <section className="product-section">
                <div className="product-section-head"><h2>Right now</h2></div>
                <div className="home-summary-row"><span>Agents working</span><strong>{running}</strong></div>
                <div className="home-summary-row"><span>Needs your attention</span><strong>{needsYou}</strong></div>
                <div className="home-summary-row"><span>Projects</span><strong>{projects.length}</strong></div>
              </section>
              <section className="home-note">
                <strong>Review stays focused.</strong>
                <p>Permissions, questions, failures, and finished changes are waiting in the Review tab.</p>
              </section>
            </aside>
          </div>
        </>
      )}

      {cardMenu ? (
        <div
          ref={cardMenuRef}
          className="ctx-menu"
          style={{
            left: Math.max(8, Math.min(cardMenu.x, window.innerWidth - 220)),
            top: cardMenuTop ?? cardMenu.y
          }}
        >
          <button className="ctx-item" onClick={() => { setCardMenu(null); void openThread(cardMenu.thread) }}>Open</button>
          <button className="ctx-item" onClick={() => { setCardMenu(null); void exportSessionMarkdown(cardMenu.thread.threadId) }}>Export as Markdown…</button>
        </div>
      ) : null}
    </div>
  )
}
