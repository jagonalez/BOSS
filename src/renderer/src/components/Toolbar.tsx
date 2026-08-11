import React from 'react'
import { useStore, appStore } from '../state/AppState'

export function Toolbar(): React.JSX.Element {
  const serverVersion = useStore(appStore, (s) => s.serverVersion)
  const serverHealthy = useStore(appStore, (s) => s.serverHealthy)
  const attention = useStore(appStore, (s) => s.attention)

  return (
    <div className="toolbar">
      <div className="spacer" />
      {attention ? (
        <div className={`attention-pill ${attention.kind}`} title="R.A.L.F. needs your attention" onClick={() => appStore.setState({ attention: null })}>
          <span className={`attention-dot ${attention.kind}`} />
          <span>{attention.kind === 'permission' ? 'Permission needed' : attention.kind === 'error' ? 'Error' : 'Done'}</span>
        </div>
      ) : null}
      <div className="server-pill" title={`OpenCode project service ${serverVersion}`}>
        <span className={`status-dot ${serverHealthy ? 'ok' : 'pulse'}`} />
        <span>{serverHealthy ? serverVersion || 'opencode' : 'connecting'}</span>
      </div>
    </div>
  )
}
