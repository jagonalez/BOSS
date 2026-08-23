import React from 'react'
import { useStore, appStore } from '../state/AppState'
import { serviceDegradations } from '../lib/status'
import { ActivityBell, ActivityPanel } from './ActivityInbox'

type AttentionKind = NonNullable<ReturnType<typeof appStore.getState>['attention']>['kind']

/** A question and a permission request both stop the run, but they ask for
 *  different things: one wants an answer typed, the other a tool call allowed.
 *  Labelling both "Permission needed" sent people hunting for an approval
 *  prompt that no thread was going to show. */
const ATTENTION_LABELS: Record<AttentionKind, string> = {
  permission: 'Permission needed',
  question: 'Answer needed',
  error: 'Error',
  done: 'Done'
}

const ATTENTION_TITLES: Record<AttentionKind, string> = {
  permission: 'A thread is waiting for you to allow or deny something',
  question: 'A thread asked you a question and is waiting for your answer',
  error: 'A run failed',
  done: 'A run finished'
}

export function Toolbar(): React.JSX.Element | null {
  const serverUrl = useStore(appStore, (s) => s.serverUrl)
  const serverHealthy = useStore(appStore, (s) => s.serverHealthy)
  const backends = useStore(appStore, (s) => s.backends)
  const attention = useStore(appStore, (s) => s.attention)
  const degradations = serviceDegradations(serverUrl, serverHealthy, backends)

  // The bell is permanent — it is how you reach the inbox even on a quiet day
  // — so the bar itself is too. It sits above every page now, so height comes
  // off the workspace on all of them either way.
  return (
    <div className="toolbar">
      <div className="spacer" />
      {attention ? (
        <div className={`attention-pill ${attention.kind}`} title={ATTENTION_TITLES[attention.kind]} onClick={() => appStore.setState({ attention: null })}>
          <span className={`attention-dot ${attention.kind}`} />
          <span>{ATTENTION_LABELS[attention.kind]}</span>
        </div>
      ) : null}
      {degradations.length ? (
        <div className="server-pill degraded" title={degradations.join('\n')}>
          <span className="status-dot" />
          <span>{degradations.length === 1 ? degradations[0] : `${degradations.length} services degraded`}</span>
        </div>
      ) : null}
      <div className="inbox-anchor">
        <ActivityBell />
        <ActivityPanel />
      </div>
    </div>
  )
}
