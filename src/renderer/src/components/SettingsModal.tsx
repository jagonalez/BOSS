import React from 'react'
import { useStore, appStore } from '../state/AppState'
import { THEMES, applyTheme } from '../lib/themes'
import { KOKORO_VOICES } from '@shared/speech'
import { setEngine, setSpeakAloud, setTtsVoice, speakText } from '../lib/actions'
import { BackendBadge } from './BackendControls'

export function SettingsModal(): React.JSX.Element | null {
  const open = useStore(appStore, (s) => s.settingsOpen)
  const ttsVoice = useStore(appStore, (s) => s.ttsVoice)
  const speakAloud = useStore(appStore, (s) => s.speakAloud)
  const tts = useStore(appStore, (s) => s.tts)
  const backends = useStore(appStore, (s) => s.backends)
  const defaultBackend = useStore(appStore, (s) => s.engine)
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
