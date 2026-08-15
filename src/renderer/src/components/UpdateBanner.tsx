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

  // Three states, and only the last asks anything of the user. Downloading
  // happens on its own, so saying so is enough; once it is staged the only
  // thing left is to stop using the old one, which the next quit does anyway.
  return (
    <div className="update-banner">
      <span className="update-banner-text">
        {status.ready
          ? `BOSS ${status.latestVersion} is ready. It will be applied next time you quit.`
          : status.downloadPercent !== undefined
            ? `Downloading BOSS ${status.latestVersion}… ${status.downloadPercent}%`
            : `BOSS ${status.latestVersion} is available. You have ${status.currentVersion}.`}
      </span>
      {status.ready ? (
        <button className="update-banner-action" onClick={() => void window.boss.updateRestart()}>
          Restart now
        </button>
      ) : null}
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
