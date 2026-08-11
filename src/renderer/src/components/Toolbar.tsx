import React from 'react'
import { useStore, appStore } from '../state/AppState'
import { setEngine } from '../lib/actions'

export function Toolbar(): React.JSX.Element {
  const serverVersion = useStore(appStore, (s) => s.serverVersion)
  const serverHealthy = useStore(appStore, (s) => s.serverHealthy)
  const attention = useStore(appStore, (s) => s.attention)
  const engine = useStore(appStore, (s) => s.engine)

  return (
    <div className="toolbar">
      <div className="spacer" />
      {attention ? (
        <div className={`attention-pill ${attention.kind}`} title="Ralf needs your attention" onClick={() => appStore.setState({ attention: null })}>
          <span className={`attention-dot ${attention.kind}`} />
          <span>{attention.kind === 'permission' ? 'Permission needed' : attention.kind === 'error' ? 'Error' : 'Done'}</span>
        </div>
      ) : null}
      <div className="engine-pill" title="Backend engine" onClick={() => setEngine(engine === 'opencode' ? 'pi' : 'opencode')}>
        <span>{engine}</span>
      </div>
      <div className="server-pill" title={`opencode ${serverVersion}`}>
        <span className={`status-dot ${serverHealthy ? 'ok' : 'pulse'}`} />
        <span>{serverHealthy ? serverVersion || 'opencode' : 'connecting'}</span>
      </div>
    </div>
  )
}
