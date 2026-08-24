import React from 'react'
import { useStore, appStore } from '../state/AppState'
import { setModel } from '../lib/actions'

export function ModelSwitchModal(): React.JSX.Element | null {
  const pending = useStore(appStore, (s) => s.modelSwitch)
  if (!pending) return null

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3>Switch model?</h3>
        <div className="body">
          Switching to <strong>{pending.to}</strong> mid-conversation invalidates this session's prompt cache, which can
          increase the latency and cost of the next turn. The conversation history carries over.
        </div>
        <div className="actions">
          <button className="btn-deny" onClick={() => appStore.setState({ modelSwitch: null })}>
            Cancel
          </button>
          <button className="btn-allow" onClick={() => { setModel(pending.to, pending.sessionId ?? null, pending.providerID); appStore.setState({ modelSwitch: null }) }}>
            Switch model
          </button>
        </div>
      </div>
    </div>
  )
}
