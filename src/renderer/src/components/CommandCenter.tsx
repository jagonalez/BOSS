import React, { useEffect, useMemo, useState } from 'react'
import type { SupervisedThread, SupervisionSnapshot, TranscriptSearchResult } from '@shared/supervision'
import { useStore, appStore } from '../state/AppState'
import { openProject, selectSession } from '../lib/actions'
import { OpenCode } from '../lib/opencode'
import { ChatIcon, ChevronIcon, SearchIcon } from './icons'
import { serviceDegradations } from '../lib/status'

function timeAgo(timestamp?: number): string {
  if (!timestamp) return 'recently'
  const diff = Date.now() - timestamp
  if (diff < 60_000) return 'now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

function duration(value: number): string {
  if (value < 60_000) return `${Math.max(1, Math.round(value / 1_000))}s`
  if (value < 3_600_000) return `${Math.round(value / 60_000)}m`
  return `${Math.round(value / 3_600_000)}h`
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

function projectName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || 'Chat'
}

async function openThread(thread: Pick<SupervisedThread, 'threadId' | 'projectPath'>): Promise<void> {
  if (thread.projectPath && thread.projectPath !== appStore.getState().projectPath) {
    await openProject(thread.projectPath)
  }
  selectSession(thread.threadId)
}

function ThreadCard({ thread, state, label }: {
  thread: SupervisedThread
  state: 'attention' | 'running' | 'recent'
  label: string
}): React.JSX.Element {
  const metrics = [
    thread.lastRun?.durationMs ? duration(thread.lastRun.durationMs) : '',
    thread.lastRun?.tokens !== undefined ? `${compactNumber(thread.lastRun.tokens)} reported tokens` : '',
    thread.lastRun?.toolCalls ? `${thread.lastRun.toolCalls} tools` : ''
  ].filter(Boolean).join(' · ')
  return (
    <button className="command-session-card" onClick={() => void openThread(thread)}>
      <span className={`command-state-icon ${state}`}><ChatIcon size={14} /></span>
      <span className="command-session-main">
        <strong>{thread.title}</strong>
        <small>{projectName(thread.projectPath)} · {thread.backendId} · {label}</small>
        {metrics ? <small className="command-session-metrics">{metrics}</small> : null}
      </span>
      <span className="command-session-time">{timeAgo(thread.updatedAt)}</span>
      <ChevronIcon size={14} />
    </button>
  )
}

function SearchResult({ result }: { result: TranscriptSearchResult }): React.JSX.Element {
  return (
    <button className="command-search-result" onClick={() => void openThread({
      threadId: result.threadId,
      projectPath: result.projectPath
    })}>
      <span className="command-search-result-meta">
        <strong>{result.title}</strong>
        <small>{projectName(result.projectPath)} · {result.backendId} · {result.kind} · {timeAgo(result.timestamp)}</small>
      </span>
      <span className="command-search-snippet">{result.snippet}</span>
      <ChevronIcon size={14} />
    </button>
  )
}

export function CommandCenter(): React.JSX.Element {
  const permissions = useStore(appStore, (state) => state.permissions)
  const questions = useStore(appStore, (state) => state.questions)
  const errors = useStore(appStore, (state) => state.lastErrorBySession)
  const serverHealthy = useStore(appStore, (state) => state.serverHealthy)
  const serverUrl = useStore(appStore, (state) => state.serverUrl)
  const backends = useStore(appStore, (state) => state.backends)
  const threadBus = useStore(appStore, (state) => state.threadBus)
  const [snapshot, setSnapshot] = useState<SupervisionSnapshot | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<TranscriptSearchResult[]>([])
  const [searching, setSearching] = useState(false)
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

  const classified = useMemo(() => {
    const threads = snapshot?.threads ?? []
    const reason = (thread: SupervisedThread): string | undefined => {
      if (permissions[thread.threadId]) return 'Permission needed'
      if (questions[thread.threadId]) return 'Answer needed'
      if (errors[thread.threadId]) return 'Run failed'
      if (threadBus?.messages.some((message) => message.fromThreadId === thread.threadId && message.status === 'failed')) return 'Thread message failed'
      if (thread.lastRun?.status === 'error') return 'Last run failed'
      if (thread.lastRun?.status === 'interrupted') return 'Run was interrupted'
      return undefined
    }
    const attention = threads.flatMap((thread) => {
      const label = reason(thread)
      return label ? [{ thread, label }] : []
    })
    const attentionIds = new Set(attention.map((item) => item.thread.threadId))
    return {
      attention,
      running: threads.filter((thread) => thread.running && !attentionIds.has(thread.threadId)),
      recent: threads.filter((thread) => !thread.running && !attentionIds.has(thread.threadId)).slice(0, 8)
    }
  }, [snapshot, permissions, questions, errors, threadBus])

  const totals = snapshot?.totals
  return (
    <div className="command-center">
      <header className="command-header">
        <div>
          <span className="command-eyebrow">Command Center</span>
          <h1>Here’s what’s happening.</h1>
          <p>Supervise work across projects and backends, then jump straight to anything that needs you.</p>
        </div>
        {degradations.length ? (
          <div className="command-connection degraded" title={degradations.join('\n')}>
            <span />{degradations.length === 1 ? degradations[0] : `${degradations.length} services degraded`}
          </div>
        ) : null}
      </header>

      <div className="command-overview">
        <div><strong>{totals?.runs ?? 0}</strong><span>runs recorded</span></div>
        <div><strong>{duration(totals?.durationMs ?? 0)}</strong><span>agent time</span></div>
        <div title="Only tokens explicitly reported by a backend are counted.">
          <strong>{totals?.tokens === undefined ? '—' : compactNumber(totals.tokens)}</strong>
          <span>reported tokens</span>
        </div>
        <div><strong>{compactNumber(totals?.toolCalls ?? 0)}</strong><span>tool calls</span></div>
      </div>

      <div className="command-search">
        <SearchIcon size={15} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search messages, reasoning, and tool activity across every project…"
          aria-label="Search work history"
        />
        {searching ? <span>Searching…</span> : query.trim().length >= 2 ? <span>{results.length} results</span> : null}
      </div>

      {query.trim().length >= 2 ? (
        <section className="command-section command-search-section">
          <div className="command-section-head"><h2>Work history</h2><span>{results.length}</span></div>
          <div className="command-list">
            {results.length > 0
              ? results.map((result) => <SearchResult key={`${result.threadId}:${result.messageId}:${result.kind}:${result.snippet}`} result={result} />)
              : <div className="command-empty">{searching ? 'Searching your work…' : 'No matching work found.'}</div>}
          </div>
        </section>
      ) : (
        <div className="command-grid">
          <section className="command-section command-attention">
            <div className="command-section-head"><h2>Needs your attention</h2><span>{classified.attention.length}</span></div>
            <div className="command-list">
              {classified.attention.length > 0
                ? classified.attention.map(({ thread, label }) => <ThreadCard key={thread.threadId} thread={thread} state="attention" label={label} />)
                : <div className="command-empty">Nothing needs you right now.</div>}
            </div>
          </section>

          <section className="command-section">
            <div className="command-section-head"><h2>Running</h2><span>{classified.running.length}</span></div>
            <div className="command-list">
              {classified.running.length > 0
                ? classified.running.map((thread) => <ThreadCard key={thread.threadId} thread={thread} state="running" label="Working" />)
                : <div className="command-empty">No agents are currently running.</div>}
            </div>
          </section>

          <section className="command-section command-recent">
            <div className="command-section-head"><h2>Recently active</h2><span>{classified.recent.length}</span></div>
            <div className="command-list">
              {classified.recent.length > 0
                ? classified.recent.map((thread) => <ThreadCard key={thread.threadId} thread={thread} state="recent" label="Updated" />)
                : <div className="command-empty">Your recent work will appear here.</div>}
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
