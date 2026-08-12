import React, { useEffect, useState } from 'react'
import type { MobileAccessStatus } from '@shared/mobile'
import { OpenCode } from '../lib/opencode'
import { Button, SettingsRow, StatusBadge } from './ui'

export function MobileSettings(): React.JSX.Element {
  const [status, setStatus] = useState<MobileAccessStatus | null>(null)
  const [showToken, setShowToken] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void OpenCode.mobileStatus().then(setStatus).catch(() => {})
  }, [])

  const apply = async (patch: Parameters<typeof OpenCode.mobileSet>[0]): Promise<void> => {
    setBusy(true)
    try {
      setStatus(await OpenCode.mobileSet(patch))
    } finally {
      setBusy(false)
    }
  }

  if (!status) return <div className="command-empty">Loading…</div>

  return (
    <div className="settings-group-stack">
      <section className="settings-card settings-card-list">
        <SettingsRow
          title="Mobile access"
          description="Serve a phone-friendly page for reviewing threads, replying, answering permission prompts, and running automations. Listens on this machine only; use Tailscale or SSH to reach it remotely."
        >
          <div className="row-inline">
            {status.running ? <StatusBadge tone="success">Running</StatusBadge> : null}
            {status.error ? <StatusBadge tone="danger">Error</StatusBadge> : null}
            <Button size="small" disabled={busy} onClick={() => void apply({ enabled: !status.enabled })}>
              {status.enabled ? 'Disable' : 'Enable'}
            </Button>
          </div>
        </SettingsRow>
        {status.error ? <div className="automation-error">{status.error}</div> : null}
        {status.running ? (
          <>
            <SettingsRow title="On this machine" description={status.url ?? ''} />
            <SettingsRow
              title="Tailscale"
              description={
                status.tailscaleUrl
                  ? `Open ${status.tailscaleUrl} on any device in your tailnet.`
                  : status.tailscaleError
                    ? `tailscale serve failed: ${status.tailscaleError}`
                    : status.tailscale
                      ? 'Publishing to your tailnet…'
                      : `Off. R.A.L.F. can run tailscale serve for you, or run it yourself: tailscale serve --bg ${status.port}`
              }
            >
              <Button size="small" disabled={busy} onClick={() => void apply({ tailscale: !status.tailscale })}>
                {status.tailscale ? 'Stop publishing' : 'Publish to tailnet'}
              </Button>
            </SettingsRow>
            <SettingsRow
              title="SSH from another desktop"
              description={`No Tailscale needed between trusted machines: ssh -L ${status.port}:localhost:${status.port} <this-machine>, then open http://localhost:${status.port}.`}
            />
            <SettingsRow
              title="Access token"
              description="Paste this once on the phone. Treat it like a password; regenerating signs every device out."
            >
              <div className="row-inline">
                <code className="mobile-token">{showToken ? status.token : '••••••••••••'}</code>
                <Button size="small" variant="ghost" onClick={() => setShowToken((value) => !value)}>
                  {showToken ? 'Hide' : 'Show'}
                </Button>
                <Button size="small" variant="ghost" onClick={() => void navigator.clipboard.writeText(status.token)}>
                  Copy
                </Button>
                <Button size="small" variant="ghost" disabled={busy} onClick={() => void apply({ regenerateToken: true })}>
                  Regenerate
                </Button>
              </div>
            </SettingsRow>
          </>
        ) : null}
      </section>
    </div>
  )
}
