import React, { useEffect, useState } from 'react'
import type { MobileAccessStatus } from '@shared/mobile'
import type { RemoteAccessStatus } from '@shared/relay'
import { OpenCode } from '../lib/opencode'
import { pairingQrDataUrl } from '../lib/qr'
import { Button, SettingsRow, StatusBadge } from './ui'

const RELAY_STATE_LABEL: Record<RemoteAccessStatus['state'], string> = {
  off: 'Off',
  connecting: 'Connecting…',
  online: 'Connected',
  error: 'Error'
}

/**
 * Remote access over the fly.io relay. The desktop dials out, so no inbound
 * port is opened. The QR code carries the relay address and a one-time
 * pairing secret; the relay never receives that secret and cannot read the
 * chat traffic it forwards.
 */
function RemoteAccessSection(): React.JSX.Element {
  const [status, setStatus] = useState<RemoteAccessStatus | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void OpenCode.remoteStatus().then(setStatus).catch(() => {})
  }, [])

  // Re-render the QR image whenever a new pairing code is issued.
  useEffect(() => {
    const code = status?.pairing?.code
    if (!code) {
      setQr(null)
      return
    }
    let live = true
    void pairingQrDataUrl(code)
      .then((url) => { if (live) setQr(url) })
      .catch((err) => { if (live) setError(err instanceof Error ? err.message : String(err)) })
    return () => { live = false }
  }, [status?.pairing?.code])

  /**
   * The socket connects, drops, and reconnects in the main process, so the
   * card has to ask rather than wait to be told. Poll while it is on screen,
   * faster while a QR code is up so a pairing lands promptly. Polling stops
   * when the modal closes, and entirely when remote access is off.
   */
  const pairing = Boolean(status?.pairing)
  const enabled = Boolean(status?.enabled)
  useEffect(() => {
    if (!enabled) return
    const timer = setInterval(() => {
      void OpenCode.remoteStatus().then(setStatus).catch(() => {})
    }, pairing ? 1500 : 4000)
    return () => clearInterval(timer)
  }, [enabled, pairing])

  const run = async (action: () => Promise<RemoteAccessStatus>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setStatus(await action())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (!status) return <div className="command-empty">Loading…</div>

  return (
    <section className="settings-card settings-card-list">
      <SettingsRow
        title="Remote access (relay)"
        description="Reach your threads from anywhere, with no Tailscale and no open port. BOSS dials out to a relay that forwards encrypted frames it cannot read."
      >
        <div className="row-inline">
          {status.state !== 'off' ? (
            <StatusBadge tone={status.state === 'online' ? 'success' : status.state === 'error' ? 'danger' : 'neutral'}>
              {RELAY_STATE_LABEL[status.state]}
            </StatusBadge>
          ) : null}
          <Button size="small" disabled={busy} onClick={() => void run(() => OpenCode.remoteSet({ enabled: !status.enabled }))}>
            {status.enabled ? 'Disable' : 'Enable'}
          </Button>
        </div>
      </SettingsRow>
      {status.error ? <div className="automation-error">{status.error}</div> : null}
      {error ? <div className="automation-error">{error}</div> : null}

      {status.enabled ? (
        <>
          <SettingsRow
            title="Relay address"
            description={`${status.relayUrl} — deploy your own from the relay/ folder and paste its URL to avoid using a shared host.`}
          >
            <input
              className="settings-input mobile-webhook"
              defaultValue={status.relayUrl}
              placeholder="wss://boss-relay.fly.dev"
              onBlur={(e) => {
                if (e.target.value.trim() && e.target.value.trim() !== status.relayUrl) {
                  void run(() => OpenCode.remoteSet({ relayUrl: e.target.value.trim() }))
                }
              }}
            />
          </SettingsRow>

          <SettingsRow
            title="Pair a phone"
            description={
              status.pairing
                ? 'Scan this with your phone camera. The code works once and expires in five minutes.'
                : 'Show a QR code, then scan it with the phone you want to use.'
            }
          >
            <div className="row-inline">
              {status.pairing ? (
                <Button size="small" variant="ghost" disabled={busy} onClick={() => void run(() => OpenCode.remotePairCancel())}>
                  Cancel
                </Button>
              ) : (
                <Button size="small" disabled={busy || status.state !== 'online'} onClick={() => void run(() => OpenCode.remotePair())}>
                  Show QR code
                </Button>
              )}
            </div>
          </SettingsRow>
          {qr ? (
            <div style={{ padding: '4px 0 12px', textAlign: 'center' }}>
              <img src={qr} alt="Pairing QR code" width={220} height={220} style={{ borderRadius: 10 }} />
            </div>
          ) : null}

          <SettingsRow
            title="Paired devices"
            description={status.devices.length ? '' : 'No phones are paired yet.'}
          >
            {status.devices.length ? (
              <Button size="small" variant="ghost" disabled={busy} onClick={() => void run(() => OpenCode.remoteSet({ revokeAll: true }))}>
                Revoke all
              </Button>
            ) : null}
          </SettingsRow>
          {status.devices.map((device) => (
            <SettingsRow
              key={device.id}
              title={device.label}
              description={`Paired ${new Date(device.pairedAt).toLocaleString()}${device.online ? ' · connected' : ''}`}
            >
              <Button size="small" variant="ghost" disabled={busy} onClick={() => void run(() => OpenCode.remoteSet({ forgetDeviceId: device.id }))}>
                Revoke
              </Button>
            </SettingsRow>
          ))}
        </>
      ) : null}
    </section>
  )
}

export function MobileSettings(): React.JSX.Element {
  const [status, setStatus] = useState<MobileAccessStatus | null>(null)
  const [showToken, setShowToken] = useState(false)
  const [showViewerToken, setShowViewerToken] = useState(false)
  const [busy, setBusy] = useState(false)
  const [webhook, setWebhook] = useState('')
  const [onlyWhenAway, setOnlyWhenAway] = useState(true)
  const [webhookSaved, setWebhookSaved] = useState(false)
  const [webhookError, setWebhookError] = useState<string | null>(null)

  useEffect(() => {
    void OpenCode.mobileStatus().then(setStatus).catch(() => {})
    void OpenCode.notifyWebhook()
      .then((settings) => {
        setWebhook(settings.url)
        setOnlyWhenAway(settings.onlyWhenAway)
      })
      .catch(() => {})
  }, [])

  const saveWebhook = async (): Promise<void> => {
    setWebhookError(null)
    try {
      const settings = await OpenCode.setNotifyWebhook(webhook)
      setWebhook(settings.url)
      setOnlyWhenAway(settings.onlyWhenAway)
      setWebhookSaved(true)
      setTimeout(() => setWebhookSaved(false), 1500)
    } catch (err) {
      setWebhookError(err instanceof Error ? err.message : String(err))
    }
  }

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
      <RemoteAccessSection />
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
                      : `Off. BOSS can run tailscale serve for you, or run it yourself: tailscale serve --bg ${status.port}`
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
                <Button size="small" variant="ghost" onClick={() => window.boss.clipboardWrite(status.token)}>
                  Copy
                </Button>
                <Button size="small" variant="ghost" disabled={busy} onClick={() => void apply({ regenerateToken: true })}>
                  Regenerate
                </Button>
              </div>
            </SettingsRow>
            <SettingsRow
              title="Read-only sharing token"
              description="Share this token when someone should review task status and transcripts without being able to reply, stop agents, approve permissions, or run automations."
            >
              <div className="row-inline">
                <code className="mobile-token">{showViewerToken ? status.viewerToken : '••••••••••••'}</code>
                <Button size="small" variant="ghost" onClick={() => setShowViewerToken((value) => !value)}>
                  {showViewerToken ? 'Hide' : 'Show'}
                </Button>
                <Button size="small" variant="ghost" onClick={() => window.boss.clipboardWrite(status.viewerToken)}>
                  Copy
                </Button>
                <Button size="small" variant="ghost" disabled={busy} onClick={() => void apply({ regenerateViewerToken: true })}>
                  Regenerate
                </Button>
              </div>
            </SettingsRow>
          </>
        ) : null}
      </section>
      <section className="settings-card settings-card-list">
        <SettingsRow
          title="Push notifications"
          description="Automation notifications also POST to this URL. Easiest: install the ntfy app, subscribe to a topic, and paste https://ntfy.sh/<your-topic> here. Leave empty to disable."
        >
          <div className="row-inline">
            <input
              className="settings-input mobile-webhook"
              value={webhook}
              placeholder="https://ntfy.sh/your-topic"
              onChange={(e) => setWebhook(e.target.value)}
            />
            <Button size="small" onClick={() => void saveWebhook()}>{webhookSaved ? 'Saved' : 'Save'}</Button>
          </div>
        </SettingsRow>
        {webhookError ? <div className="automation-error">{webhookError}</div> : null}
        <SettingsRow
          title="Only push when I'm away"
          description="Skip the phone push while a BOSS window is focused, so you are not told twice about something already on screen. Turn this off if you leave BOSS open on a machine you walk away from."
        >
          <label className="settings-computer-toggle">
            <input
              type="checkbox"
              aria-label="Only push when I'm away"
              checked={onlyWhenAway}
              onChange={(event) => {
                const next = event.target.checked
                setOnlyWhenAway(next)
                void OpenCode.setNotifyWebhookOnlyWhenAway(next)
                  .then((settings) => setOnlyWhenAway(settings.onlyWhenAway))
                  .catch(() => setOnlyWhenAway(!next))
              }}
            />
            <span>{onlyWhenAway ? 'On' : 'Off'}</span>
          </label>
        </SettingsRow>
      </section>
    </div>
  )
}
