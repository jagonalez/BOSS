import React from 'react'
import { useStore, appStore } from '../state/AppState'
import { OpenCode } from '../lib/opencode'

export function PermissionModal(): React.JSX.Element | null {
  const permission = useStore(appStore, (s) => s.permission)
  if (!permission) return null

  const respond = async (response: string, remember?: boolean): Promise<void> => {
    try {
      await OpenCode.respondPermission(permission.sessionID, permission.id, response, remember)
    } catch {
      /* ignore */
    }
    appStore.setState({ permission: null })
  }

  const detail =
    permission.description ||
    (permission.input !== undefined ? JSON.stringify(permission.input, null, 2) : '') ||
    (permission.tool ? `Tool: ${permission.tool}` : '') ||
    'opencode is requesting permission.'

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3>Permission requested</h3>
        <div className="body">{detail}</div>
        <div className="actions">
          <button className="btn-deny" onClick={() => void respond('rejected')}>
            Deny
          </button>
          <button className="btn-deny" onClick={() => void respond('rejected', true)}>
            Always deny
          </button>
          <button className="btn-allow" onClick={() => void respond('allowed')}>
            Allow
          </button>
        </div>
      </div>
    </div>
  )
}
