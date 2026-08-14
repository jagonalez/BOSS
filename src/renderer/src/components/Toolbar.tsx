import React from 'react'
import { useStore, appStore } from '../state/AppState'
import { serviceDegradations } from '../lib/status'

export function Toolbar(): React.JSX.Element | null {
  const serverUrl = useStore(appStore, (s) => s.serverUrl)
  const serverHealthy = useStore(appStore, (s) => s.serverHealthy)
  const backends = useStore(appStore, (s) => s.backends)
  const attention = useStore(appStore, (s) => s.attention)
  const degradations = serviceDegradations(serverUrl, serverHealthy, backends)

  // Nothing to say, no bar. It sits above every page now, so an empty one
  // would take height from the workspace on all of them.
  if (!attention && !degradations.length) return null

  return (
    <div className="toolbar">
      <div className="spacer" />
      {attention ? (
        <div className={`attention-pill ${attention.kind}`} title="BOSS needs your attention" onClick={() => appStore.setState({ attention: null })}>
          <span className={`attention-dot ${attention.kind}`} />
          <span>{attention.kind === 'permission' ? 'Permission needed' : attention.kind === 'error' ? 'Error' : 'Done'}</span>
        </div>
      ) : null}
      {degradations.length ? (
        <div className="server-pill degraded" title={degradations.join('\n')}>
          <span className="status-dot" />
          <span>{degradations.length === 1 ? degradations[0] : `${degradations.length} services degraded`}</span>
        </div>
      ) : null}
    </div>
  )
}
