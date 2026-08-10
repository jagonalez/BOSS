import React from 'react'
import { useStore, appStore } from '../state/AppState'
import { THEMES, applyTheme } from '../lib/themes'

export function SettingsModal(): React.JSX.Element | null {
  const open = useStore(appStore, (s) => s.settingsOpen)
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
        <div className="actions">
          <button className="btn-deny" onClick={() => appStore.setState({ settingsOpen: false })}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
