import React, { useEffect, useState } from 'react'
import { useStore, appStore } from '../state/AppState'
import { OpenCode } from '../lib/opencode'
import { importAgentSession } from '../lib/actions'
import { formatRelativeTime } from '../lib/activity-feed'
import { projectName } from '../lib/project-name'
import { errorSummary } from '../lib/errors'
import type { SessionInfo } from '@shared/opencode'

/** Pick a Claude Code session run outside BOSS and continue it as a thread.
 *
 *  Agents can do the same through boss_threads_import; this is for when the
 *  session the user wants is one BOSS has never seen, so there is no thread
 *  yet to ask from. */
export function ImportSessionModal(): React.JSX.Element | null {
  const open = useStore(appStore, (s) => s.importOpen)
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null)
  const [error, setError] = useState('')
  const [importing, setImporting] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let current = true
    setSessions(null)
    setError('')
    OpenCode.importableSessions('claude')
      .then((found) => { if (current) setSessions(found) })
      .catch((failure) => { if (current) { setSessions([]); setError(errorSummary(failure)) } })
    return () => { current = false }
  }, [open])

  if (!open) return null

  const close = (): void => appStore.setState({ importOpen: false })
  const bringIn = async (id: string): Promise<void> => {
    setImporting(id)
    setError('')
    try {
      await importAgentSession('claude', id)
      close()
    } catch (failure) {
      setError(errorSummary(failure))
    } finally {
      setImporting(null)
    }
  }

  const now = Date.now()
  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal import-modal" role="dialog" aria-label="Import a Claude Code session" onClick={(event) => event.stopPropagation()}>
        <h3>Import a Claude Code session</h3>
        <p className="import-hint">
          BOSS copies the conversation and continues the same session. Close it in the terminal first, so that two
          processes do not add to it.
        </p>
        {sessions === null ? (
          <p className="import-hint">Looking for sessions…</p>
        ) : sessions.length === 0 && !error ? (
          <p className="import-hint">No Claude Code sessions to import. Sessions that are already threads are not listed.</p>
        ) : (
          <ul className="import-list" aria-label="Claude Code sessions">
            {sessions.map((session) => (
              <li key={session.id}>
                <button
                  className="import-row"
                  disabled={importing !== null}
                  onClick={() => void bringIn(session.id)}
                >
                  <span className="import-title">{session.title || 'Untitled session'}</span>
                  <span className="import-meta">
                    {session.directory ? projectName(session.directory) : 'No folder'}
                    {session.time?.updated ? ` · ${formatRelativeTime(session.time.updated, now)}` : ''}
                    {importing === session.id ? ' · Importing…' : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {error && <p className="import-error" role="alert">{error}</p>}
        <div className="actions">
          <button className="btn-deny" onClick={close}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
