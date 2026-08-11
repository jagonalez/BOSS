import React, { useEffect, useState } from 'react'
import { useStore, appStore } from '../state/AppState'
import type { SiteInfo } from '@shared/ipc'
import {
  clearCloudflareConfig,
  deploySite,
  openSiteInBrowser,
  publishSiteFromPicker,
  refreshSites,
  removeSite,
  setCloudflareConfig
} from '../lib/actions'
import { CopyIcon, ExternalIcon, GlobeIcon, PlusIcon, ReloadIcon, TrashIcon, UploadIcon } from './icons'

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return 'now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

function copy(text: string): void {
  void navigator.clipboard.writeText(text)
}

function SiteRow({ site }: { site: SiteInfo }): React.JSX.Element {
  const deploying = useStore(appStore, (s) => Boolean(s.siteDeploying[site.id]))
  const [copied, setCopied] = useState(false)
  const url = site.deployedUrl ?? site.localUrl
  const label = deploying
    ? 'Deploying…'
    : site.status === 'live'
      ? 'Live'
      : site.status === 'error'
        ? 'Deploy failed'
        : 'Local'

  const doCopy = (): void => {
    copy(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  return (
    <div className={`site-card status-${site.status}`}>
      <div className="site-card-head">
        <span className="command-state-icon">
          <GlobeIcon size={14} />
        </span>
        <div className="command-session-main">
          <strong>{site.name}</strong>
          <small title={site.folder}>{site.folder}</small>
        </div>
        <span className={`site-badge status-${site.status}`}>{label}</span>
        <span className="site-time">{timeAgo(site.lastPublishedAt)}</span>
      </div>
      <div className="site-card-url">
        <span className="site-url" title={url}>{url}</span>
      </div>
      {site.status === 'error' && site.error ? <div className="site-error">{site.error}</div> : null}
      <div className="site-card-actions">
        <button className="btn-ghost" onClick={() => void openSiteInBrowser(site.localUrl)} title="Open in Ralf's browser tab">
          <GlobeIcon size={13} /> Open in Ralf
        </button>
        <button className="btn-ghost" onClick={() => void window.ralf.openExternal(url)} title="Open in default browser">
          <ExternalIcon size={13} /> Open external
        </button>
        <button className="btn-ghost" onClick={doCopy} title="Copy URL">
          <CopyIcon size={13} /> {copied ? 'Copied' : 'Copy URL'}
        </button>
        <button
          className="btn-ghost"
          disabled={deploying}
          onClick={() => void deploySite(site.id)}
          title="Deploy to Cloudflare Workers"
        >
          <UploadIcon size={13} /> {site.deployedUrl ? 'Redeploy' : 'Deploy'}
        </button>
        <button className="btn-ghost" onClick={() => void refreshSites()} title="Refresh">
          <ReloadIcon size={13} /> Refresh
        </button>
        <button
          className="btn-ghost"
          onClick={() =>
            appStore.setState({
              confirm: {
                title: 'Remove site?',
                message: `Remove "${site.name}"? It will stop being served locally.${site.deployedUrl ? ' The deployed copy on Cloudflare stays.' : ''}`,
                confirmLabel: 'Remove',
                destructive: true,
                action: () => void removeSite(site.id)
              }
            })
          }
          title="Remove site"
        >
          <TrashIcon size={13} /> Remove
        </button>
      </div>
    </div>
  )
}

function CloudflareSection(): React.JSX.Element {
  const cf = useStore(appStore, (s) => s.cloudflare)
  const [open, setOpen] = useState(false)
  const [token, setToken] = useState('')
  const [accountId, setAccountId] = useState(cf.accountId ?? '')
  const [saving, setSaving] = useState(false)

  const save = async (): Promise<void> => {
    setSaving(true)
    await setCloudflareConfig(token, accountId)
    setSaving(false)
    setOpen(false)
    setToken('')
  }

  return (
    <div className="site-cf-section">
      <div className="site-cf-info">
        <strong>Cloudflare</strong>
        <small>
          {cf.configured
            ? `Connected — account ${cf.accountId}`
            : 'Not configured. Add a scoped API token to deploy sites to Workers Static Assets.'}
        </small>
      </div>
      <div className="site-cf-actions">
        {cf.configured ? (
          <button className="btn-ghost" onClick={() => void clearCloudflareConfig()}>
            Disconnect
          </button>
        ) : (
          <button className="btn-ghost" onClick={() => setOpen(true)}>
            Connect…
          </button>
        )}
      </div>
      {open ? (
        <div className="site-cf-form">
          <label className="settings-row">
            <span className="settings-row-label">API token</span>
            <input
              type="password"
              className="settings-input"
              placeholder="scoped to Workers Scripts → Edit"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </label>
          <label className="settings-row">
            <span className="settings-row-label">Account ID</span>
            <input
              className="settings-input"
              placeholder="Cloudflare account ID"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
            />
          </label>
          <div className="site-cf-form-actions">
            <button className="btn-ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className="btn-allow" disabled={saving || !token.trim() || !accountId.trim()} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export function SitesPage(): React.JSX.Element {
  const sites = useStore(appStore, (s) => s.sites)

  useEffect(() => {
    void refreshSites()
    void window.ralf.sitesCfGet().then((cf) => appStore.setState({ cloudflare: cf })).catch(() => {})
  }, [])

  return (
    <div className="command-center sites-page">
      <header className="command-header">
        <div>
          <span className="command-eyebrow">Ralf</span>
          <h1>Sites</h1>
          <p>Publish a folder of static files to preview it locally and optionally deploy it to Cloudflare Workers.</p>
        </div>
        <button className="site-publish-btn" onClick={() => void publishSiteFromPicker()}>
          <PlusIcon size={14} /> Publish folder…
        </button>
      </header>

      <div className="sites-layout">
        <div className="sites-main">
          <div className="command-section">
            <div className="command-section-head">
              <h2>Published sites</h2>
              <span>{sites.length}</span>
            </div>
            <div className="command-list">
              {sites.length > 0 ? (
                sites.map((site) => <SiteRow key={site.id} site={site} />)
              ) : (
                <div className="command-empty">
                  No sites yet. Publish a folder to preview it locally — the agent can also do this for you.
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="sites-side">
          <CloudflareSection />
        </div>
      </div>
    </div>
  )
}
