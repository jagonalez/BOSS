import React from 'react'
import { useStore, appStore } from '../state/AppState'
import { toggleComputerUse } from '../lib/actions'

export function Footer(): React.JSX.Element {
  const computerUse = useStore(appStore, (s) => s.computerUse)

  return (
    <div className="footer">
      <div className="right">
        <label className="toggle">
          <input
            type="checkbox"
            checked={computerUse.enabled}
            onChange={(e) => void toggleComputerUse(e.target.checked)}
          />
          Computer use
        </label>
        {computerUse.enabled ? (
          <span className="perm-hint" title="Grant Accessibility (click/type) and Screen Recording (screenshots) to Ralf in System Settings → Privacy & Security">
            needs Accessibility + Screen Recording perms
          </span>
        ) : null}
        {computerUse.error ? <span className="perm-hint error">{computerUse.error}</span> : null}
      </div>
    </div>
  )
}
