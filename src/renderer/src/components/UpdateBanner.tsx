import React, { useEffect, useState } from 'react'
import type { UpdateStatus } from '@shared/ipc'

export function UpdateBanner(): React.JSX.Element | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)

  useEffect(() => {
    void window.boss
      .updateStatus()
      .then(setStatus)
      .catch(() => {})
    return window.boss.onUpdateChanged(setStatus)
  }, [])

  if (!status?.available || !status.latestVersion) return null
  if (dismissed === status.latestVersion) return null

  return (
    <div className="update-banner">
      <span className="update-banner-text">
        BOSS {status.latestVersion} is available. You have {status.currentVersion}.
      </span>
      <button className="update-banner-action" onClick={() => void window.boss.openExternal(status.url)}>
        Download
      </button>
      <button
        className="update-banner-dismiss"
        aria-label="Dismiss"
        onClick={() => setDismissed(status.latestVersion ?? null)}
      >
        ✕
      </button>
    </div>
  )
}
