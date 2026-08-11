import React, { useEffect, useState } from 'react'
import { useStore, appStore } from '../state/AppState'
import { THEMES, applyTheme } from '../lib/themes'
import { KOKORO_VOICES } from '@shared/speech'
import { clearThreadBusFailures, importNativeThreads, setEngine, setSpeakAloud, setThreadBusPolicy, setTtsVoice, speakText } from '../lib/actions'
import { BackendBadge } from './BackendControls'
import { OpenCode } from '../lib/opencode'
import type { WorktreeSettings } from '@shared/worktree'

export function SettingsModal(): React.JSX.Element | null {
  const open = useStore(appStore, (s) => s.settingsOpen)
  const ttsVoice = useStore(appStore, (s) => s.ttsVoice)
  const speakAloud = useStore(appStore, (s) => s.speakAloud)
  const tts = useStore(appStore, (s) => s.tts)
  const backends = useStore(appStore, (s) => s.backends)
  const defaultBackend = useStore(appStore, (s) => s.engine)
  const threadBus = useStore(appStore, (s) => s.threadBus)
  const [importStatus, setImportStatus] = useState('')
  const [worktreeSettings, setWorktreeSettings] = useState<WorktreeSettings | null>(null)
  useEffect(() => {
    if (!open) return
    void OpenCode.worktreeSettings().then(setWorktreeSettings).catch(() => {})
  }, [open])
  if (!open) return null

  const current = document.documentElement.dataset.theme ?? 'graphite'

  return (
    <div className="modal-backdrop" onClick={() => appStore.setState({ settingsOpen: false })}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Settings</h3>
        <div className="settings-section-title">Agents</div>
        <div className="settings-backends">
          {backends.map((backend) => (
            <button
              key={backend.id}
              className={`settings-backend ${defaultBackend === backend.id ? 'active' : ''}`}
              disabled={!backend.available}
              onClick={() => void setEngine(backend.id)}
              title={backend.available ? backend.description : backend.unavailableReason}
            >
              <BackendBadge backendId={backend.id} />
              <span><strong>{backend.label}</strong><small>{backend.available ? backend.version || 'Available' : backend.unavailableReason}</small></span>
              {defaultBackend === backend.id ? <em>Default</em> : null}
            </button>
          ))}
        </div>
        <div className="settings-row-hint">The default is used by quick-create. Every project workspace can choose a backend when creating a thread.</div>
        <div className="settings-row">
          <div className="settings-row-main">
            <div className="settings-row-label">Existing OpenCode sessions</div>
            <div className="settings-row-hint">R.A.L.F. only manages sessions it creates. Import existing OpenCode sessions when you want them to appear as R.A.L.F. threads.</div>
          </div>
          <button
            className="btn-ghost"
            onClick={() => {
              setImportStatus('Importing…')
              void importNativeThreads('opencode')
                .then((count) => setImportStatus(count ? `Imported ${count}` : 'Nothing new'))
                .catch(() => setImportStatus('Import failed'))
            }}
          >
            Import
          </button>
        </div>
        {importStatus ? <div className="settings-row-hint">{importStatus}</div> : null}
        <div className="settings-section-title">Thread collaboration</div>
        <div className="settings-row">
          <div className="settings-row-main">
            <div className="settings-row-label">Agent access</div>
            <div className="settings-row-hint">
              Scoped to this project. OpenCode, Pi, Codex CLI, and Claude Code threads can use the thread tools.
            </div>
          </div>
          <select
            className="settings-select"
            value={threadBus?.policy ?? 'off'}
            onChange={(event) => void setThreadBusPolicy(event.target.value as 'off' | 'read' | 'collaborate')}
          >
            <option value="off">Off</option>
            <option value="read">Read-only</option>
            <option value="collaborate">Read and send</option>
          </select>
        </div>
        <div className="settings-row-hint">
          {threadBus?.messages.length
            ? `${threadBus.messages.filter((message) => message.status === 'queued').length} queued · ${threadBus.messages.filter((message) => message.status === 'failed').length} failed · ${threadBus.messages.length} recent`
            : 'No agent-to-agent messages in this project yet.'}
        </div>
        {threadBus?.messages.some((message) => message.status === 'failed') ? (
          <button className="btn-ghost" onClick={() => void clearThreadBusFailures()}>Clear failed messages</button>
        ) : null}
        <div className="settings-section-title">Git worktrees</div>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={worktreeSettings?.autoCleanupEnabled ?? true}
            onChange={(event) => {
              const autoCleanupEnabled = event.target.checked
              setWorktreeSettings((current) => ({
                autoCleanupEnabled,
                cleanupAfterDays: current?.cleanupAfterDays ?? 30
              }))
              void OpenCode.setWorktreeSettings({ autoCleanupEnabled }).then(setWorktreeSettings)
            }}
          />
          <span>
            <span className="settings-row-label">Clean up inactive worktrees</span>
            <span className="settings-row-hint">Only clean worktrees created by R.A.L.F. are eligible. Dirty or locked worktrees are always kept.</span>
          </span>
        </label>
        <div className="settings-row">
          <div className="settings-row-main">
            <div className="settings-row-label">Inactive threshold</div>
            <div className="settings-row-hint">Opening or using a worktree thread resets its timer.</div>
          </div>
          <select
            className="settings-select"
            value={worktreeSettings?.cleanupAfterDays ?? 30}
            onChange={(event) => {
              const cleanupAfterDays = Number(event.target.value)
              setWorktreeSettings((current) => ({
                autoCleanupEnabled: current?.autoCleanupEnabled ?? true,
                cleanupAfterDays
              }))
              void OpenCode.setWorktreeSettings({ cleanupAfterDays }).then(setWorktreeSettings)
            }}
          >
            <option value={7}>7 days</option>
            <option value={14}>14 days</option>
            <option value={30}>30 days</option>
            <option value={60}>60 days</option>
            <option value={90}>90 days</option>
          </select>
        </div>
        <div className="settings-section-title">Theme</div>
        <div className="theme-grid">
          {THEMES.map((t) => (
            <button
              key={t.id}
              className={`theme-swatch ${t.id === current ? 'active' : ''}`}
              onClick={() => applyTheme(t.id)}
              title={t.label}
            >
              <span
                className="theme-swatch-preview"
                style={{ background: `linear-gradient(135deg, ${t.bg} 0%, ${t.bg} 55%, ${t.accent} 100%)` }}
              />
              <span className="theme-swatch-label">{t.label}</span>
            </button>
          ))}
        </div>
        <div className="settings-section-title">Voice</div>
        <div className="settings-row">
          <div className="settings-row-main">
            <div className="settings-row-label">Voice</div>
            <div className="settings-row-hint">
              {tts.ready ? 'Ready' : tts.error ?? (tts.available ? 'Loading…' : 'Unavailable')}
            </div>
          </div>
          <select
            className="settings-select"
            value={ttsVoice}
            onChange={(e) => setTtsVoice(e.target.value)}
          >
            {KOKORO_VOICES.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
          <button
            className="btn-ghost"
            disabled={!tts.available || tts.speaking}
            onClick={() => void speakText('This is the ' + ttsVoice + ' voice.')}
            title="Preview this voice (first click downloads the model)"
          >
            {tts.speaking ? 'Loading…' : 'Preview'}
          </button>
        </div>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={speakAloud}
            onChange={(e) => setSpeakAloud(e.target.checked)}
          />
          <span>
            <span className="settings-row-label">Speak responses aloud</span>
            <span className="settings-row-hint">Read new assistant messages out loud</span>
          </span>
        </label>
        <div className="actions">
          <button className="btn-deny" onClick={() => appStore.setState({ settingsOpen: false })}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
