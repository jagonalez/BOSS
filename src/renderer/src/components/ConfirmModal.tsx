import React from 'react'
import { useStore, appStore } from '../state/AppState'

export function ConfirmModal(): React.JSX.Element | null {
  const confirm = useStore(appStore, (s) => s.confirm)
  if (!confirm) return null

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3>{confirm.title}</h3>
        <div className="body">{confirm.message}</div>
        <div className="actions">
          <button className="btn-deny" onClick={() => appStore.setState({ confirm: null })}>
            Cancel
          </button>
          <button
            className={`btn-allow ${confirm.destructive ? 'danger' : ''}`}
            onClick={() => {
              appStore.setState({ confirm: null })
              confirm.action()
            }}
          >
            {confirm.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
