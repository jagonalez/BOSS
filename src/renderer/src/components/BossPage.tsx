import React, { useEffect, useMemo } from 'react'
import { ChatView } from './ChatView'
import { appStore, useStore } from '../state/AppState'
import { askAssistant, loadMessages } from '../lib/actions'

/** The standing conversation with BOSS.
 *
 *  One conversation, and nothing else on the page. The surface this replaces
 *  showed an attention list, a running-work strip, a build-failure list, a role
 *  editor, and a task queue around a chat squeezed into a side panel — and the
 *  user never used it, because chatting already felt natural and the rest read
 *  as a control panel.
 *
 *  Everything those panels showed, BOSS can say. It knows which jobs exist and
 *  what state each is in, and it answers by looking rather than from memory. A
 *  list the user has to read and cross-reference is the thing an assistant is
 *  for. */
export function BossPage(): React.JSX.Element {
  const sessionMeta = useStore(appStore, (state) => state.sessionMeta)
  const sessions = useStore(appStore, (state) => state.sessions)
  const sessionId = useMemo(() => {
    const id = Object.values(sessionMeta).find((meta) => meta.kind === 'assistant')?.sessionId
    return id && sessions.some((session) => session.id === id) ? id : null
  }, [sessionMeta, sessions])

  useEffect(() => {
    // Started on arrival rather than on the first message, so the composer is
    // ready and the seeding round trip does not sit between the user's first
    // sentence and its answer.
    if (!sessionId) void askAssistant()
  }, [sessionId])

  useEffect(() => {
    if (sessionId) void loadMessages(sessionId)
  }, [sessionId])

  if (!sessionId) {
    return (
      <div className="boss-page boss-page-starting">
        <span>Starting…</span>
      </div>
    )
  }

  return (
    <div className="boss-page">
      <ChatView sessionId={sessionId} active />
    </div>
  )
}
