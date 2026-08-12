import React, { useEffect, useRef, useState } from 'react'
import { useStore, appStore } from '../state/AppState'
import { THEMES, applyTheme, loadTheme } from '../lib/themes'
import { KOKORO_VOICES } from '@shared/speech'
import { clearThreadBusFailures, openBackendLogin, refreshBackendAuth, refreshBackendModels, refreshComputerUsePermissions, refreshQaDefault, setDefaultModel, setEngine, setQaDefault, setSpeakAloud, setThreadBusPolicy, setTtsVoice, speakText, toggleComputerUse } from '../lib/actions'
import { BackendBadge } from './BackendControls'
import { OpenCode } from '../lib/opencode'
import type { BackendId, BackendModelDescriptor, BackendModelPreference } from '@shared/backend'
import type { WorktreeSettings } from '@shared/worktree'
import type { QaPolicy } from '@shared/qa'
import { Button, Select, SettingsRow, StatusBadge } from './ui'
import { McpSettings } from './McpSettings'

type SettingsSection = 'agents' | 'connections' | 'mcp' | 'collaboration' | 'worktrees' | 'appearance' | 'voice'

const SETTINGS_GROUPS: Array<{ label: string; items: Array<{ id: SettingsSection; label: string }> }> = [
  {
    label: 'R.A.L.F.',
    items: [
      { id: 'agents', label: 'Agent defaults' },
      { id: 'connections', label: 'Models & connections' },
      { id: 'mcp', label: 'MCP connections' }
    ]
  },
  {
    label: 'Projects',
    items: [
      { id: 'collaboration', label: 'Collaboration' },
      { id: 'worktrees', label: 'Git worktrees' }
    ]
  },
  {
    label: 'Personalize',
    items: [
      { id: 'appearance', label: 'Appearance' },
      { id: 'voice', label: 'Voice' }
    ]
  }
]

const SETTINGS_HEADINGS: Record<SettingsSection, { title: string; description: string }> = {
  agents: {
    title: 'Agent defaults',
    description: 'Choose how new R.A.L.F. threads start.'
  },
  connections: {
    title: 'Models & connections',
    description: 'See what every agent can use, connect cloud accounts, and choose defaults for new threads.'
  },
  mcp: {
    title: 'MCP connections',
    description: 'Connect MCP servers once; every backend and automation can use their tools through R.A.L.F.'
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

const THEME_CATEGORIES = ['R.A.L.F.', 'Community', 'Accessibility'] as const

function modelValue(providerID: string, modelID: string): string {
  return JSON.stringify([providerID, modelID])
}

const LOCAL_PROVIDER_IDS = new Set(['ollama', 'llama.cpp', 'llamacpp', 'lmstudio', 'lm-studio', 'vllm', 'sglang'])

function modelIsLocal(model: BackendModelDescriptor, backendId: BackendId): boolean {
  return model.source === 'local' || LOCAL_PROVIDER_IDS.has((model.provider || backendId).toLowerCase())
}

function providerIsLocal(provider: string, models: BackendModelDescriptor[], backendId: BackendId): boolean {
  return models.some((model) => (model.provider || backendId) === provider && modelIsLocal(model, backendId))
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
          {selected ? <small>{selected.providerID}{selectedModel && modelIsLocal(selectedModel, backendId) ? ' · Local' : ''}</small> : null}
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
            {[...grouped].sort(([providerA, itemsA], [providerB, itemsB]) => {
              if (providerA === selected?.providerID) return -1
              if (providerB === selected?.providerID) return 1
              const localA = itemsA.some((model) => modelIsLocal(model, backendId))
              const localB = itemsB.some((model) => modelIsLocal(model, backendId))
              return localA === localB ? providerA.localeCompare(providerB) : localA ? -1 : 1
            }).map(([provider, items]) => (
              <div className="settings-model-provider" key={provider}>
                <div className="settings-model-provider-heading">
                  <span>{provider}</span>
                  {items.some((model) => modelIsLocal(model, backendId)) ? <em>Local</em> : null}
                </div>
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
  const qaDefault = useStore(appStore, (s) => s.qaDefault)
  const computerUse = useStore(appStore, (s) => s.computerUse)
  const computerUsePerms = useStore(appStore, (s) => s.computerUsePerms)
  const [section, setSection] = useState<SettingsSection>('connections')
  const [currentTheme, setCurrentTheme] = useState(loadTheme)
  const [worktreeSettings, setWorktreeSettings] = useState<WorktreeSettings | null>(null)

  useEffect(() => {
    if (!open) return
    void OpenCode.worktreeSettings().then(setWorktreeSettings).catch(() => {})
    void refreshBackendAuth()
    void refreshBackendModels()
    void refreshQaDefault()
  }, [open])

  useEffect(() => {
    const syncTheme = (event: Event): void => {
      setCurrentTheme((event as CustomEvent<{ id?: string }>).detail?.id ?? loadTheme())
    }
    window.addEventListener('ralf:theme-changed', syncTheme)
    return () => window.removeEventListener('ralf:theme-changed', syncTheme)
  }, [])

  if (!open) return null

  const heading = SETTINGS_HEADINGS[section]
  const missingComputerPermissions = computerUsePerms.available
    ? [
        !computerUsePerms.accessibility ? 'Accessibility' : '',
        !computerUsePerms.screenRecording ? 'Screen Recording' : ''
      ].filter(Boolean)
    : []

  return (
    <div className="settings-page">
      <header className="settings-page-titlebar">
        <div className="settings-page-title">
          <strong>Settings</strong>
          <span>Configure R.A.L.F. across projects</span>
        </div>
        <Button variant="primary" size="small" onClick={() => appStore.setState({ settingsOpen: false })}>Done</Button>
      </header>

      <div className="settings-page-body">
        <aside className="settings-sidebar" aria-label="Settings categories">
          <nav>
            {SETTINGS_GROUPS.map((group) => (
              <div className="settings-nav-group" key={group.label}>
                <div className="settings-nav-label">{group.label}</div>
                {group.items.map((item) => (
                  <button
                    key={item.id}
                    className={section === item.id ? 'active' : ''}
                    onClick={() => setSection(item.id)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
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

                <section className="settings-card settings-card-list">
                  <SettingsRow
                    title="Agent QA"
                    description="Default for threads without an override. Suggest allows browser inspection; native inspection also uses the Computer use switch. Use /qa auto, /qa suggest, /qa off, or /qa default inside a thread to change only that thread."
                  >
                    <Select value={qaDefault} onChange={(event) => void setQaDefault(event.target.value as QaPolicy)}>
                      <option value="suggest">Suggest — inspect only</option>
                      <option value="automatic">Automatic — allow scoped actions</option>
                      <option value="off">Off</option>
                    </Select>
                  </SettingsRow>
                  <SettingsRow
                    title="Computer use"
                    description="Allows scoped native-app inspection and interaction. Browser QA does not require this service."
                  >
                    <label className="settings-computer-toggle">
                      <input
                        type="checkbox"
                        disabled={!computerUse.supported}
                        checked={computerUse.enabled}
                        onChange={(event) => void toggleComputerUse(event.target.checked)}
                      />
                      <span>{computerUse.enabled ? 'On' : 'Off'}</span>
                    </label>
                    {!computerUse.supported ? <StatusBadge tone="danger">Unavailable</StatusBadge> : null}
                    {computerUse.enabled && missingComputerPermissions.length === 0 && !computerUse.error ? <StatusBadge tone="success">Ready</StatusBadge> : null}
                    {computerUse.enabled && missingComputerPermissions.length > 0 ? (
                      <>
                        <StatusBadge tone="warning">Needs {missingComputerPermissions.join(' + ')}</StatusBadge>
                        <Button size="small" onClick={() => void refreshComputerUsePermissions(true)}>Fix permissions</Button>
                      </>
                    ) : null}
                    {computerUse.error ? <StatusBadge tone="danger">{computerUse.error}</StatusBadge> : null}
                  </SettingsRow>
                </section>
              </div>
            ) : null}

            {section === 'connections' ? (
              <div className="settings-group-stack">
                <div className="settings-connections-explainer">
                  <div>
                    <strong>Backends own their model access</strong>
                    <p>R.A.L.F. discovers the providers already configured in each agent. Local models stay on your machine; credentials remain in the backend's own store.</p>
                  </div>
                </div>
                <section className="settings-connections-panel">
                  <div className="settings-connections-table-head" aria-hidden="true">
                    <span>Agent runtime</span>
                    <span>Model access</span>
                    <span>New threads</span>
                    <span />
                  </div>
                  {backends.map((backend) => {
                    const auth = (backendAuth ?? []).find((item) => item.backendId === backend.id)
                    const models = backendModels[backend.id] ?? []
                    const selected = defaultModels[backend.id]
                    const providers = [...new Set(models.map((model) => model.provider || backend.id))]
                    const localProviders = providers.filter((provider) => providerIsLocal(provider, models, backend.id))
                    const hasCloudAccount = auth?.state === 'connected'
                    const accessDetail = localProviders.length
                      ? `${localProviders.join(', ')} available locally${hasCloudAccount ? ` · ${auth.detail}` : ''}`
                      : hasCloudAccount
                        ? `${auth.detail}${auth.accounts?.length ? ` · ${auth.accounts.join(', ')}` : ''}`
                        : providers.length
                          ? `${providers.length} model provider${providers.length === 1 ? '' : 's'} available through ${backend.label}`
                          : auth?.detail ?? 'Checking model access…'
                    return (
                      <div className="settings-connection-row" key={backend.id}>
                        <div className="settings-runtime">
                          <BackendBadge backendId={backend.id} />
                          <div className="settings-runtime-copy">
                            <h2>{backend.label}</h2>
                            <small>{backend.available ? backend.version || 'CLI available' : backend.unavailableReason}</small>
                          </div>
                        </div>

                        <div className="settings-access">
                          <div className="settings-access-badges">
                            <StatusBadge tone={backend.available ? 'success' : 'danger'}>{backend.available ? 'Runtime ready' : 'Unavailable'}</StatusBadge>
                            {localProviders.length ? <StatusBadge tone="local">Local · {localProviders.join(', ')}</StatusBadge> : null}
                            {hasCloudAccount ? <StatusBadge tone="accent">Cloud connected</StatusBadge> : null}
                          </div>
                          <p>{accessDetail}</p>
                        </div>

                        <div className="settings-connection-model">
                          <span>Default model</span>
                          <DefaultModelPicker
                            backendId={backend.id}
                            models={models}
                            selected={selected}
                            loading={backendModelsLoading}
                            disabled={!backend.available || backendModelsLoading || (models.length === 0 && !selected)}
                          />
                        </div>

                        <Button size="small" disabled={!backend.available} onClick={() => openBackendLogin(backend.id)}>
                          {hasCloudAccount ? 'Manage' : 'Add account'}
                        </Button>
                      </div>
                    )
                  })}
                </section>
              </div>
            ) : null}

            {section === 'mcp' ? <McpSettings /> : null}

            {section === 'collaboration' ? (
              <div className="settings-group-stack">
                <section className="settings-card settings-card-list">
                  <SettingsRow title="Agent access" description="Scoped to this project. OpenCode, Pi, Codex CLI, and Claude Code threads can use the thread tools.">
                  <Select
                    value={threadBus?.policy ?? 'off'}
                    onChange={(event) => void setThreadBusPolicy(event.target.value as 'off' | 'read' | 'collaborate')}
                  >
                    <option value="off">Off</option>
                    <option value="read">Read-only</option>
                    <option value="collaborate">Read and send</option>
                  </Select>
                  </SettingsRow>
                  <SettingsRow title="Recent agent messages" description={
                    <>
                      {threadBus?.messages.length
                        ? `${threadBus.messages.filter((message) => message.status === 'queued').length} queued · ${threadBus.messages.filter((message) => message.status === 'failed').length} failed · ${threadBus.messages.length} recent`
                        : 'No agent-to-agent messages in this project yet.'}
                    </>
                  }>
                  {threadBus?.messages.some((message) => message.status === 'failed') ? (
                    <Button size="small" onClick={() => void clearThreadBusFailures()}>Clear failures</Button>
                  ) : null}
                  </SettingsRow>
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
                <section className="settings-card settings-card-list">
                  <SettingsRow title="Inactive threshold" description="Opening or using a worktree thread resets its timer.">
                  <Select
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
                  </Select>
                  </SettingsRow>
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
                <div className="settings-theme-families">
                  {THEME_CATEGORIES.map((category) => (
                    <div className="settings-theme-family" key={category}>
                      <div className="settings-theme-family-label">{category}</div>
                      <div className="theme-grid settings-theme-grid">
                        {THEMES.filter((theme) => theme.category === category).map((theme) => (
                          <button
                            key={theme.id}
                            className={`theme-swatch ${theme.id === currentTheme ? 'active' : ''}`}
                            onClick={() => applyTheme(theme.id)}
                            title={theme.label}
                          >
                            <span className="theme-swatch-preview" style={{ background: theme.colors.canvas }}>
                              <span style={{ background: theme.colors.sidebar }} />
                              <span style={{ background: theme.colors.surface }}>
                                <i style={{ background: theme.colors.accent }} />
                                <i style={{ background: theme.colors.textMuted }} />
                                <i style={{ background: theme.colors.success }} />
                              </span>
                            </span>
                            <span className="theme-swatch-copy">
                              <span><strong>{theme.label}</strong><em>{theme.appearance}</em></span>
                              <small>{theme.description}</small>
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
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
                  <Select value={ttsVoice} onChange={(event) => setTtsVoice(event.target.value)}>
                    {KOKORO_VOICES.map((voice) => (
                      <option key={voice.id} value={voice.id}>{voice.label}</option>
                    ))}
                  </Select>
                  <Button
                    size="small"
                    disabled={!tts.available || tts.speaking}
                    onClick={() => void speakText('This is the ' + ttsVoice + ' voice.')}
                    title="Preview this voice (first click downloads the model)"
                  >{tts.speaking ? 'Loading…' : 'Preview'}</Button>
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
