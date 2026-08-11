import React from 'react'
import { useStore, appStore } from '../state/AppState'
import { toggleComputerUse } from '../lib/actions'

export function Footer(): React.JSX.Element {
  const computerUse = useStore(appStore, (s) => s.computerUse)
  const perms = useStore(appStore, (s) => s.computerUsePerms)

  const missing: Array<{ id: 'accessibility' | 'screenRecording'; label: string }> = []
  if (perms.available) {
    if (!perms.accessibility) missing.push({ id: 'accessibility', label: 'Accessibility' })
    if (!perms.screenRecording) missing.push({ id: 'screenRecording', label: 'Screen Recording' })
  }

  async function fixPermissions(): Promise<void> {
    for (const m of missing) {
      await window.ralf.requestComputerUsePermission(m.id).catch(() => {})
    }
    const next = await window.ralf.computerUsePermissions().catch(() => perms)
    appStore.setState({ computerUsePerms: next })
    if (!next.accessibility || !next.screenRecording) {
      await window.ralf.openPrivacyPane(next.accessibility ? 'screenRecording' : 'accessibility').catch(() => {})
    }
  }

  return (
    <div className="footer">
      <div className="right">
        <label className="toggle">
          <input
            type="checkbox"
            disabled={!computerUse.supported}
            checked={computerUse.enabled}
            onChange={(e) => void toggleComputerUse(e.target.checked)}
          />
          Computer use
        </label>
        {!computerUse.supported ? (
          <span className="perm-hint" title="The active engine does not support MCP tool servers">
            not supported on this engine
          </span>
        ) : computerUse.enabled && perms.available && missing.length > 0 ? (
          <>
            <span className="perm-hint warn" title="Grant these in System Settings → Privacy & Security">
              needs {missing.map((m) => m.label).join(' + ')} permission
            </span>
            <button
              className="btn-ghost"
              onClick={() => void fixPermissions()}
              title="Prompt macOS to grant permission"
            >
              Fix
            </button>
          </>
        ) : computerUse.enabled ? (
          <span className="perm-hint">permissions OK</span>
        ) : null}
        {computerUse.error ? <span className="perm-hint error">{computerUse.error}</span> : null}
      </div>
    </div>
  )
}
