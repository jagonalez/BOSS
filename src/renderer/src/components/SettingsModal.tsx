import React from 'react'
import { useStore, appStore } from '../state/AppState'
import { THEMES, applyTheme } from '../lib/themes'
import { POCKET_VOICES } from '@shared/speech'
import { setSpeakAloud, setTtsVoice, speakText } from '../lib/actions'

export function SettingsModal(): React.JSX.Element | null {
  const open = useStore(appStore, (s) => s.settingsOpen)
  const ttsVoice = useStore(appStore, (s) => s.ttsVoice)
  const speakAloud = useStore(appStore, (s) => s.speakAloud)
  const tts = useStore(appStore, (s) => s.tts)
  if (!open) return null

  const current = document.documentElement.dataset.theme ?? 'graphite'

  return (
    <div className="modal-backdrop" onClick={() => appStore.setState({ settingsOpen: false })}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Settings</h3>
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
            <div className="settings-row-label">Pocket voice</div>
            <div className="settings-row-hint">
              {tts.available ? (tts.ready ? 'Ready' : 'Loading…') : 'Pocket TTS not installed (bots/marvin/tts/.venv-pt)'}
            </div>
          </div>
          <select
            className="settings-select"
            value={ttsVoice}
            onChange={(e) => setTtsVoice(e.target.value)}
          >
            {POCKET_VOICES.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
          <button
            className="btn-ghost"
            disabled={!tts.ready}
            onClick={() => void speakText('This is the ' + ttsVoice + ' voice.')}
            title="Preview this voice"
          >
            Preview
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
