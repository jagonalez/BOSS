import React, { useEffect, useState } from 'react'
import { useStore, appStore } from '../state/AppState'
import { THEMES, applyTheme, loadTheme } from '../lib/themes'
import { KOKORO_VOICES } from '@shared/speech'
import { clearThreadBusFailures, openBackendLogin, refreshBackendAuth, refreshBackendModels, refreshComputerUsePermissions, refreshQaDefault, setBackendDefault, setDefaultModel, setEngine, setQaDefault, setSpeakAloud, setTerminalStartLocation, setThreadBusPolicy, setTtsVoice, speakText, toggleComputerUse } from '../lib/actions'
import { BackendBadge } from './BackendControls'
import { OpenCode } from '../lib/opencode'
import type { BackendDescriptor, BackendId, BackendModeId, BackendModelDescriptor, BackendModelPreference } from '@shared/backend'
import type { WorktreeLocation, WorktreeSettings } from '@shared/worktree'
import type { QaPolicy } from '@shared/qa'
import { Button, Select, SettingsRow, StatusBadge } from './ui'
import { McpSettings } from './McpSettings'
import { MobileSettings } from './MobileSettings'
import { ModelSelect, modelIsLocal } from './ModelSelect'

type SettingsSection = 'agents' | 'connections' | 'mcp' | 'mobile' | 'collaboration' | 'worktrees' | 'appearance' | 'voice'

const SETTINGS_GROUPS: Array<{ label: string; items: Array<{ id: SettingsSection; label: string }> }> = [
  {
    label: 'BOSS',
    items: [
      { id: 'agents', label: 'Agent defaults' },
      { id: 'connections', label: 'Models & connections' },
      { id: 'mcp', label: 'MCP connections' },
      { id: 'mobile', label: 'Mobile access' }
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
    description: 'Choose how new BOSS threads start.'
  },
  connections: {
    title: 'Models & connections',
    description: 'See what every agent can use, connect cloud accounts, and choose defaults for new threads.'
  },
  mcp: {
    title: 'MCP connections',
    description: 'Connect MCP servers once; every backend and automation can use their tools through BOSS'
  },
  mobile: {
    title: 'Mobile access',
    description: 'Review threads and automations from your phone over your tailnet or an SSH tunnel.'
  },
  collaboration: {
    title: 'Collaboration',
    description: 'Control how threads in the same project can discover and communicate with one another.'
  },
  worktrees: {
    title: 'Git worktrees',
    description: 'Manage the isolated worktrees BOSS creates for project threads.'
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

const THEME_CATEGORIES = ['BOSS', 'Community', 'Accessibility'] as const

function providerIsLocal(provider: string, models: BackendModelDescriptor[], backendId: BackendId): boolean {
  return models.some((model) => (model.provider || backendId) === provider && modelIsLocal(model, backendId))
}

/** What a new thread on this backend starts with.
 *
 *  Mode is per backend because the modes are the backend's own — codex has no
 *  accept-edits and pi has one mode, so a single setting for all of them would
 *  offer something half cannot do.
 *
 *  Thinking is per model, not per backend: claude's Sonnet stops at high where
 *  Opus goes to max, and codex reads the levels from each model. A level is
 *  saved against the default model and ignored if the thread is on another. */
function BackendDefaults({
  backend,
  models,
  selected
}: {
  backend: BackendDescriptor
  models: BackendModelDescriptor[]
  selected?: BackendModelPreference
}): React.JSX.Element | null {
  const variants = models.find((model) => model.id === selected?.modelID)?.variants ?? []
  if (backend.modes.length <= 1 && variants.length === 0) return null
  return (
    <div className="settings-defaults">
      {backend.modes.length > 1 ? (
        <label>
          <span>Permissions</span>
          <Select
            value={selected?.mode ?? backend.modes[0]?.id ?? 'ask'}
            disabled={!selected}
            onChange={(event) => {
              const mode = event.target.value as BackendModeId
              // Every future thread on this backend, not just one. The picker
              // in the composer asks before turning auto on for a single
              // thread; a default that does it for all of them silently would
              // be the weaker check.
              if (mode !== 'auto') {
                setBackendDefault(backend.id, { mode })
                return
              }
              appStore.setState({
                confirm: {
                  title: `Start every ${backend.label} thread on auto-approve?`,
                  message: 'New threads will approve supported actions without asking, so an agent may run destructive commands or modify files before you see them. Each thread can still be changed afterwards.',
                  confirmLabel: 'Use auto by default',
                  destructive: true,
                  action: () => setBackendDefault(backend.id, { mode })
                }
              })
            }}
          >
            {backend.modes.map((mode) => (
              <option key={mode.id} value={mode.id}>{mode.label}</option>
            ))}
          </Select>
        </label>
      ) : null}
      {variants.length ? (
        <label>
          <span>Thinking</span>
          <Select
            value={selected?.variant ?? ''}
            onChange={(event) => setBackendDefault(backend.id, { variant: event.target.value || undefined })}
          >
            <option value="">Backend default</option>
            {variants.map((variant) => (
              <option key={variant} value={variant}>{variant}</option>
            ))}
          </Select>
        </label>
      ) : null}
    </div>
  )
}

/** Mirrors the main process's defaults. Only used to fill a field the stored
 *  settings predate, so a saved file without one does not read as undefined. */
const DEFAULT_WORKTREE_SETTINGS = { autoCleanupEnabled: true, cleanupAfterDays: 30, location: 'app-data' as const }

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
  return (
    <ModelSelect
      backendId={backendId}
      models={models}
      selected={selected}
      loading={loading}
      disabled={disabled}
      onPick={(model) => setDefaultModel(backendId, model)}
    />
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
  const terminalStartLocation = useStore(appStore, (s) => s.terminalStartLocation)
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
    window.addEventListener('boss:theme-changed', syncTheme)
    return () => window.removeEventListener('boss:theme-changed', syncTheme)
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
          <span>Configure BOSS across projects</span>
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
                    <p>BOSS discovers the providers already configured in each agent. Local models stay on your machine; credentials remain in the backend's own store.</p>
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
                          <BackendDefaults backend={backend} models={models} selected={selected} />
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

            {section === 'mobile' ? <MobileSettings /> : null}

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
                <section className="settings-card settings-card-list">
                  <SettingsRow
                    title="Where worktrees go"
                    description={worktreeSettings?.location === 'project'
                      ? 'In .boss/worktrees inside each project, so a worktree can reach the project\u2019s installed dependencies. BOSS adds .boss/ to the repository\u2019s local exclude file, which is not committed and does not reach your colleagues.'
                      : 'Outside your projects, in the app\u2019s data directory. Nothing appears in your repositories, but a new worktree starts with nothing installed.'}
                  >
                    <Select
                      value={worktreeSettings?.location ?? 'app-data'}
                      onChange={(event) => {
                        const location = event.target.value as WorktreeLocation
                        setWorktreeSettings((current) => ({ ...DEFAULT_WORKTREE_SETTINGS, ...current, location }))
                        void OpenCode.setWorktreeSettings({ location }).then(setWorktreeSettings)
                      }}
                    >
                      <option value="app-data">App data directory</option>
                      <option value="project">Inside the project</option>
                    </Select>
                  </SettingsRow>
                </section>
                <section className="settings-card">
                  <label className="settings-check">
                    <input
                      type="checkbox"
                      checked={worktreeSettings?.autoCleanupEnabled ?? true}
                      onChange={(event) => {
                        const autoCleanupEnabled = event.target.checked
                        setWorktreeSettings((current) => ({ ...DEFAULT_WORKTREE_SETTINGS, ...current, autoCleanupEnabled }))
                        void OpenCode.setWorktreeSettings({ autoCleanupEnabled }).then(setWorktreeSettings)
                      }}
                    />
                    <span>
                      <span className="settings-row-label">Clean up inactive worktrees</span>
                      <span className="settings-row-hint">Only clean worktrees created by BOSS are eligible. Dirty or locked worktrees are always kept.</span>
                    </span>
                  </label>
                </section>
                <section className="settings-card settings-card-list">
                  <SettingsRow
                    title="New terminal location"
                    description="Chooses a checkout when a terminal tab is created. Existing terminals stay pinned to their original folder."
                  >
                    <Select
                      value={terminalStartLocation}
                      onChange={(event) => setTerminalStartLocation(event.target.value as 'focused-checkout' | 'project-root')}
                    >
                      <option value="focused-checkout">Focused thread’s checkout</option>
                      <option value="project-root">Project root</option>
                    </Select>
                  </SettingsRow>
                  <SettingsRow title="Inactive threshold" description="Opening or using a worktree thread resets its timer.">
                  <Select
                    value={worktreeSettings?.cleanupAfterDays ?? 30}
                    disabled={worktreeSettings?.autoCleanupEnabled === false}
                    onChange={(event) => {
                      const cleanupAfterDays = Number(event.target.value)
                      setWorktreeSettings((current) => ({ ...DEFAULT_WORKTREE_SETTINGS, ...current, cleanupAfterDays }))
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
                    <p>Applied immediately across every BOSS window.</p>
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
