import React, { useEffect, useRef, useState } from 'react'
import { useStore, appStore } from '../state/AppState'
import { THEMES, applyTheme } from '../lib/themes'
import { KOKORO_VOICES } from '@shared/speech'
import { clearThreadBusFailures, importNativeThreads, openBackendLogin, refreshBackendAuth, refreshBackendModels, setDefaultModel, setEngine, setSpeakAloud, setThreadBusPolicy, setTtsVoice, speakText } from '../lib/actions'
import { BackendBadge } from './BackendControls'
import { OpenCode } from '../lib/opencode'
import type { BackendId, BackendModelDescriptor, BackendModelPreference } from '@shared/backend'
import type { WorktreeSettings } from '@shared/worktree'

type SettingsSection = 'agents' | 'connections' | 'collaboration' | 'worktrees' | 'appearance' | 'voice'

const SETTINGS_SECTIONS: Array<{ id: SettingsSection; label: string }> = [
  { id: 'agents', label: 'Agents' },
  { id: 'connections', label: 'Connections' },
  { id: 'collaboration', label: 'Collaboration' },
  { id: 'worktrees', label: 'Git worktrees' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'voice', label: 'Voice' }
]

const SETTINGS_HEADINGS: Record<SettingsSection, { title: string; description: string }> = {
  agents: {
    title: 'Agents',
    description: 'Choose how new work starts and bring existing agent sessions into R.A.L.F.'
  },
  connections: {
    title: 'Connections',
    description: 'Connect agent backends and choose the model each one uses for new threads.'
  },
  collaboration: {
    title: 'Collaboration',
    description: 'Control how threads in the same project can discover and communicate with one another.'
  },
  worktrees: {
    title: 'Git worktrees',
    description: 'Manage the isolated worktrees R.A.L.F. creates for project threads.'
  },
  appearance: {
    title: 'Appearance',
    description: 'Choose the visual theme used throughout the app.'
  },
  voice: {
    title: 'Voice',
    description: 'Configure spoken responses and preview the available voices.'
  }
}

function modelValue(providerID: string, modelID: string): string {
  return JSON.stringify([providerID, modelID])
}

function DefaultModelPicker({
  backendId,
  models,
  selected,
  loading,
  disabled
}: {
  backendId: BackendId
  models: BackendModelDescriptor[]
  selected?: BackendModelPreference
  loading: boolean
  disabled: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent): void => {
      if (!root.current?.contains(event.target as Node)) {
        setOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const selectedModel = selected
    ? models.find((model) => model.id === selected.modelID && (model.provider || backendId) === selected.providerID)
    : undefined
  const normalizedQuery = query.trim().toLowerCase()
  const visibleModels = normalizedQuery
    ? models.filter((model) => `${model.name ?? ''} ${model.id} ${model.provider ?? backendId}`.toLowerCase().includes(normalizedQuery))
    : models
  const grouped = new Map<string, BackendModelDescriptor[]>()
  for (const model of visibleModels) {
    const provider = model.provider || backendId
    grouped.set(provider, [...(grouped.get(provider) ?? []), model])
  }

  const pick = (model: BackendModelDescriptor | null): void => {
    setDefaultModel(backendId, model)
    setOpen(false)
    setQuery('')
  }

  return (
    <div className="settings-model-picker" ref={root}>
      <button
        className="settings-model-picker-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span>
          <strong>{loading ? 'Loading models…' : selectedModel?.name || selected?.modelID || (models.length ? 'Automatic' : 'No models available')}</strong>
          {selected ? <small>{selected.providerID}</small> : null}
        </span>
        <span className="settings-model-picker-chevron">⌄</span>
      </button>
      {open ? (
        <div className="settings-model-picker-menu">
          <input
            autoFocus
            className="settings-model-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setOpen(false)
                setQuery('')
              }
            }}
            placeholder="Search models…"
            aria-label={`Search ${backendId} models`}
          />
          <div className="settings-model-results" role="listbox">
            {!normalizedQuery || 'automatic'.includes(normalizedQuery) ? (
              <button className={!selected ? 'active' : ''} onClick={() => pick(null)}>
                <span>Automatic</span>
                {!selected ? <em>✓</em> : null}
              </button>
            ) : null}
            {selected && !selectedModel ? (
              <button className="active" onClick={() => pick(null)}>
                <span>{selected.modelID}<small>{selected.providerID} · unavailable</small></span>
                <em>Clear</em>
              </button>
            ) : null}
            {[...grouped].map(([provider, items]) => (
              <div className="settings-model-provider" key={provider}>
                <div>{provider}</div>
                {[...items].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)).map((model) => {
                  const active = selected?.modelID === model.id && selected.providerID === provider
                  return (
                    <button key={modelValue(provider, model.id)} className={active ? 'active' : ''} onClick={() => pick(model)}>
                      <span>{model.name || model.id}{model.name && model.name !== model.id ? <small>{model.id}</small> : null}</span>
                      {active ? <em>✓</em> : null}
                    </button>
                  )
                })}
              </div>
            ))}
            {visibleModels.length === 0 && normalizedQuery ? <div className="settings-model-empty">No matching models</div> : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

export function SettingsModal(): React.JSX.Element | null {
  const open = useStore(appStore, (s) => s.settingsOpen)
  const ttsVoice = useStore(appStore, (s) => s.ttsVoice)
  const speakAloud = useStore(appStore, (s) => s.speakAloud)
  const tts = useStore(appStore, (s) => s.tts)
  const backends = useStore(appStore, (s) => s.backends)
  const defaultBackend = useStore(appStore, (s) => s.engine)
  const threadBus = useStore(appStore, (s) => s.threadBus)
  const backendAuth = useStore(appStore, (s) => s.backendAuth)
  const backendModels = useStore(appStore, (s) => s.backendModels ?? {})
  const backendModelsLoading = useStore(appStore, (s) => s.backendModelsLoading ?? false)
  const defaultModels = useStore(appStore, (s) => s.defaultModels ?? {})
  const [section, setSection] = useState<SettingsSection>('connections')
  const [importStatus, setImportStatus] = useState('')
  const [worktreeSettings, setWorktreeSettings] = useState<WorktreeSettings | null>(null)

  useEffect(() => {
    if (!open) return
    void OpenCode.worktreeSettings().then(setWorktreeSettings).catch(() => {})
    void refreshBackendAuth()
    void refreshBackendModels()
  }, [open])

  if (!open) return null

  const currentTheme = document.documentElement.dataset.theme ?? 'graphite'
  const heading = SETTINGS_HEADINGS[section]

  return (
    <div className="settings-page">
      <header className="settings-page-titlebar">
        <div className="settings-page-title">Settings</div>
        <button className="settings-done-button" onClick={() => appStore.setState({ settingsOpen: false })}>
          Done
        </button>
      </header>

      <div className="settings-page-body">
        <aside className="settings-sidebar" aria-label="Settings categories">
          <nav>
            {SETTINGS_SECTIONS.map((item) => (
              <button
                key={item.id}
                className={section === item.id ? 'active' : ''}
                onClick={() => setSection(item.id)}
              >
                {item.label}
              </button>
            ))}
          </nav>
        </aside>

        <main className="settings-content">
          <div className="settings-content-inner">
            <div className="settings-content-heading">
              <h1>{heading.title}</h1>
              <p>{heading.description}</p>
            </div>

            {section === 'agents' ? (
              <div className="settings-group-stack">
                <section className="settings-card">
                  <div className="settings-card-heading">
                    <div>
                      <h2>Default agent</h2>
                      <p>Used by quick-create. You can still choose a different backend for every thread.</p>
                    </div>
                  </div>
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
                        <span>
                          <strong>{backend.label}</strong>
                          <small>{backend.available ? backend.version || 'Available' : backend.unavailableReason}</small>
                        </span>
                        {defaultBackend === backend.id ? <em>Default</em> : null}
                      </button>
                    ))}
                  </div>
                </section>

                <section className="settings-card settings-card-row">
                  <div className="settings-row-main">
                    <div className="settings-row-label">Existing OpenCode sessions</div>
                    <div className="settings-row-hint">Import existing OpenCode sessions when you want them to appear as R.A.L.F. threads. R.A.L.F. only manages sessions it creates or imports.</div>
                    {importStatus ? <div className="settings-inline-status">{importStatus}</div> : null}
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
                </section>
              </div>
            ) : null}

            {section === 'connections' ? (
              <div className="settings-group-stack">
                <div className="settings-connection-grid">
                  {backends.map((backend) => {
                    const auth = (backendAuth ?? []).find((item) => item.backendId === backend.id)
                    const models = backendModels[backend.id] ?? []
                    const selected = defaultModels[backend.id]
                    return (
                      <section className="settings-connection-card" key={backend.id}>
                        <div className="settings-connection-header">
                          <BackendBadge backendId={backend.id} />
                          <div>
                            <h2>{backend.label}</h2>
                            <span className={`connection-state ${auth?.state ?? 'unknown'}`}>
                              {auth?.state === 'connected' ? 'Connected' : auth?.state === 'not-connected' ? 'Not connected' : 'Checking…'}
                            </span>
                          </div>
                        </div>

                        <p className="settings-connection-detail">
                          {auth?.detail ?? 'Checking the CLI credential store…'}
                          {auth?.accounts?.length ? ` · ${auth.accounts.join(', ')}` : ''}
                        </p>

                        <div className="settings-field">
                          <span>Default model for new threads</span>
                          <DefaultModelPicker
                            backendId={backend.id}
                            models={models}
                            selected={selected}
                            loading={backendModelsLoading}
                            disabled={!backend.available || backendModelsLoading || (models.length === 0 && !selected)}
                          />
                        </div>

                        <div className="settings-connection-actions">
                          <span>{backend.available ? backend.version || 'CLI available' : backend.unavailableReason}</span>
                          <button className="btn-ghost" disabled={!backend.available} onClick={() => openBackendLogin(backend.id)}>
                            {auth?.state === 'connected' ? 'Re-authenticate' : 'Connect'}
                          </button>
                        </div>
                      </section>
                    )
                  })}
                </div>
                <p className="settings-page-note">R.A.L.F. launches each agent's own login flow and uses its existing credential store. Credentials are never copied into R.A.L.F.</p>
              </div>
            ) : null}

            {section === 'collaboration' ? (
              <div className="settings-group-stack">
                <section className="settings-card settings-card-row">
                  <div className="settings-row-main">
                    <div className="settings-row-label">Agent access</div>
                    <div className="settings-row-hint">Scoped to this project. OpenCode, Pi, Codex CLI, and Claude Code threads can use the thread tools.</div>
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
                </section>
                <section className="settings-card settings-card-row">
                  <div className="settings-row-main">
                    <div className="settings-row-label">Recent agent messages</div>
                    <div className="settings-row-hint">
                      {threadBus?.messages.length
                        ? `${threadBus.messages.filter((message) => message.status === 'queued').length} queued · ${threadBus.messages.filter((message) => message.status === 'failed').length} failed · ${threadBus.messages.length} recent`
                        : 'No agent-to-agent messages in this project yet.'}
                    </div>
                  </div>
                  {threadBus?.messages.some((message) => message.status === 'failed') ? (
                    <button className="btn-ghost" onClick={() => void clearThreadBusFailures()}>Clear failures</button>
                  ) : null}
                </section>
              </div>
            ) : null}

            {section === 'worktrees' ? (
              <div className="settings-group-stack">
                <section className="settings-card">
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
                </section>
                <section className="settings-card settings-card-row">
                  <div className="settings-row-main">
                    <div className="settings-row-label">Inactive threshold</div>
                    <div className="settings-row-hint">Opening or using a worktree thread resets its timer.</div>
                  </div>
                  <select
                    className="settings-select"
                    value={worktreeSettings?.cleanupAfterDays ?? 30}
                    disabled={worktreeSettings?.autoCleanupEnabled === false}
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
                </section>
              </div>
            ) : null}

            {section === 'appearance' ? (
              <section className="settings-card">
                <div className="settings-card-heading">
                  <div>
                    <h2>Theme</h2>
                    <p>Applied immediately across every R.A.L.F. window.</p>
                  </div>
                </div>
                <div className="theme-grid settings-theme-grid">
                  {THEMES.map((theme) => (
                    <button
                      key={theme.id}
                      className={`theme-swatch ${theme.id === currentTheme ? 'active' : ''}`}
                      onClick={() => applyTheme(theme.id)}
                      title={theme.label}
                    >
                      <span
                        className="theme-swatch-preview"
                        style={{ background: `linear-gradient(135deg, ${theme.bg} 0%, ${theme.bg} 55%, ${theme.accent} 100%)` }}
                      />
                      <span className="theme-swatch-label">{theme.label}</span>
                    </button>
                  ))}
                </div>
              </section>
            ) : null}

            {section === 'voice' ? (
              <div className="settings-group-stack">
                <section className="settings-card settings-card-row">
                  <div className="settings-row-main">
                    <div className="settings-row-label">Voice</div>
                    <div className="settings-row-hint">{tts.ready ? 'Ready' : tts.error ?? (tts.available ? 'Loading…' : 'Unavailable')}</div>
                  </div>
                  <select className="settings-select" value={ttsVoice} onChange={(event) => setTtsVoice(event.target.value)}>
                    {KOKORO_VOICES.map((voice) => (
                      <option key={voice.id} value={voice.id}>{voice.label}</option>
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
                </section>
                <section className="settings-card">
                  <label className="settings-check">
                    <input type="checkbox" checked={speakAloud} onChange={(event) => setSpeakAloud(event.target.checked)} />
                    <span>
                      <span className="settings-row-label">Speak responses aloud</span>
                      <span className="settings-row-hint">Read new assistant messages out loud.</span>
                    </span>
                  </label>
                </section>
              </div>
            ) : null}
          </div>
        </main>
      </div>
    </div>
  )
}
