import React from 'react'
import { useStore, appStore } from '../state/AppState'
import { PanelIcon } from './icons'

export function Toolbar(): React.JSX.Element {
  const serverVersion = useStore(appStore, (s) => s.serverVersion)
  const serverHealthy = useStore(appStore, (s) => s.serverHealthy)
  const panelOpen = useStore(appStore, (s) => s.panelOpen)
  const attention = useStore(appStore, (s) => s.attention)

  return (
    <div className="toolbar">
      <div className="spacer" />
      {attention ? (
        <div className={`attention-pill ${attention.kind}`} title="Ralf needs your attention" onClick={() => appStore.setState({ attention: null })}>
          <span className={`attention-dot ${attention.kind}`} />
          <span>{attention.kind === 'permission' ? 'Permission needed' : attention.kind === 'error' ? 'Error' : 'Done'}</span>
        </div>
      ) : null}
      <button className="btn-ghost" onClick={() => appStore.setState({ panelOpen: !panelOpen })}>
        <PanelIcon size={14} />
        <span>{panelOpen ? 'Hide panel' : 'Show panel'}</span>
      </button>
      <div className="server-pill" title={`opencode ${serverVersion}`}>
        <span className={`status-dot ${serverHealthy ? 'ok' : 'pulse'}`} />
        <span>{serverHealthy ? serverVersion || 'opencode' : 'connecting'}</span>
      </div>
    </div>
  )
}
