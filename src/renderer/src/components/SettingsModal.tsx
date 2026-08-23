import React, { useEffect, useMemo, useState } from 'react'
import { useStore, appStore } from '../state/AppState'
import { THEMES, applyTheme, loadTheme, type UiDensity, type UiFontSize } from '../lib/themes'
import { loadTypography, saveTypography, stepReadingSize, stepTerminalSize } from '../lib/typography'
import { searchSettings, type SettingsMatch } from '../lib/settings-index'
import { SearchIcon } from './icons'
import { MONO_FONTS, READING_SIZE, TERMINAL_SIZE, UI_FONTS } from '@shared/typography'
import { KOKORO_VOICES } from '@shared/speech'
import type { ViewMode } from '@shared/workspace'
import { clearThreadBusFailures, loadEngine, openBackendLogin, refreshBackendAuth, refreshBackendModels, refreshComputerUsePermissions, refreshQaDefault, refreshSubscriptionUsage, restartBackend, setBackendDefault, setDefaultModel, setEngine, setQaDefault, setSpeakAloud, setTerminalStartLocation, setUiDensity, setUiFontSize, setViewMode, setThreadBusDefaultPolicy, setThreadBusPolicy, setTtsVoice, speakText, toggleComputerUse } from '../lib/actions'
import { projectName } from './CommandCenter'
import { BackendBadge } from './BackendControls'
import { OpenCode } from '../lib/opencode'
import type { BackendDescriptor, BackendId, BackendModeId, BackendModelDescriptor, BackendModelPreference, BackendSubscriptionUsage, LabConnection, LabConnectionsSettings, SandboxSettings, ThreadTitleSettings } from '@shared/backend'
import type { WorktreeLocation, WorktreeSettings } from '@shared/worktree'
import type { QaPolicy } from '@shared/qa'
import type { CollaborationPolicy } from '@shared/thread-bus'
import type { CliStatus, UpdateChannel, UpdateStatus } from '@shared/ipc'
import { Button, Select, SettingsRow, StatusBadge } from './ui'
import { McpSettings } from './McpSettings'
import { MobileSettings } from './MobileSettings'
import { TelegramSettings } from './TelegramSettings'
import { ModelSelect, modelIsLocal } from './ModelSelect'

type SettingsSection = 'agents' | 'connections' | 'usage' | 'mcp' | 'mobile' | 'telegram' | 'collaboration' | 'worktrees' | 'appearance' | 'voice' | 'updates'

const SETTINGS_GROUPS: Array<{ label: string; items: Array<{ id: SettingsSection; label: string }> }> = [
  {
    label: 'BOSS',
    items: [
      { id: 'agents', label: 'Agent defaults' },
      { id: 'connections', label: 'Models & connections' },
      { id: 'usage', label: 'Usage' },
      { id: 'mcp', label: 'MCP connections' },
      { id: 'mobile', label: 'Mobile access' },
      { id: 'telegram', label: 'Telegram' }
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
      { id: 'voice', label: 'Voice' },
      { id: 'updates', label: 'Updates' }
    ]
  }
]

/** What each section is called, so a result can say where it will take you. */
const SECTION_LABELS: Record<SettingsSection, string> = Object.fromEntries(
  SETTINGS_GROUPS.flatMap((group) => group.items.map((item) => [item.id, item.label]))
) as Record<SettingsSection, string>

function resetDescription(usage: BackendSubscriptionUsage['windows'][number]): string {
  if (usage.resetLabel) return `Resets ${usage.resetLabel}`
  if (usage.resetsAt) return `Resets ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(usage.resetsAt)}`
  return 'Reset time unavailable'
}

function formatPercent(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)
}

function SubscriptionUsage({ usage }: { usage?: BackendSubscriptionUsage }): React.JSX.Element {
  if (!usage) return <p className="settings-subscription-unavailable">Checking subscription limits…</p>
  if (usage.windows.length === 0) {
    return <p className="settings-subscription-unavailable">{usage.unavailableReason ?? 'Subscription limits unavailable.'}</p>
  }
  const groups = [...new Set(usage.windows.map((window) => window.group ?? ''))]
  return (
    <div className="settings-subscription-usage">
      {groups.map((group) => (
        <div className="settings-subscription-group" key={group || 'default'}>
          {group ? <h3>{group}</h3> : null}
          {usage.windows.filter((window) => (window.group ?? '') === group).map((window) => {
            const remaining = Math.max(0, 100 - window.usedPercent)
            return (
              <div className="settings-subscription-window" key={`${window.label}:${window.resetsAt ?? window.resetLabel ?? ''}`}>
                <div><span>{window.label}</span><strong>{formatPercent(window.usedPercent)}% used · {formatPercent(remaining)}% left</strong></div>
                <div className="settings-subscription-meter" aria-label={`${window.label}: ${formatPercent(remaining)}% remaining`}><span style={{ width: `${window.usedPercent}%` }} /></div>
                <small>{resetDescription(window)}</small>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

/** The layout choices, each drawn rather than described. A silhouette says
 *  what changes faster than a sentence does. */
const VIEW_MODES: Array<{
  id: ViewMode
  label: string
  description: string
  silhouette: React.JSX.Element
}> = [
  {
    id: 'multi',
    label: 'Multi-thread',
    description: 'Several threads at once, split however you arrange them.',
    silhouette: (
      <svg viewBox="0 0 64 44" aria-hidden="true">
        <rect x="1" y="1" width="62" height="42" rx="4" className="viewmode-frame" />
        <rect x="5" y="9" width="26" height="30" rx="2" className="viewmode-pane" />
        <rect x="35" y="9" width="24" height="14" rx="2" className="viewmode-pane" />
        <rect x="35" y="25" width="24" height="14" rx="2" className="viewmode-pane" />
        <rect x="5" y="4" width="12" height="3" rx="1.5" className="viewmode-tab" />
        <rect x="35" y="4" width="10" height="3" rx="1.5" className="viewmode-tab" />
      </svg>
    )
  },
  {
    id: 'single',
    label: 'Single-thread',
    description: 'One thread filling the window, with its own tabs. No splits.',
    silhouette: (
      <svg viewBox="0 0 64 44" aria-hidden="true">
        <rect x="1" y="1" width="62" height="42" rx="4" className="viewmode-frame" />
        <rect x="5" y="9" width="54" height="30" rx="2" className="viewmode-pane" />
        <rect x="5" y="4" width="12" height="3" rx="1.5" className="viewmode-tab active" />
        <rect x="19" y="4" width="10" height="3" rx="1.5" className="viewmode-tab" />
        <rect x="31" y="4" width="10" height="3" rx="1.5" className="viewmode-tab" />
      </svg>
    )
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
  usage: {
    title: 'Usage',
    description: 'See how much remains in each provider subscription window and when it resets.'
  },
  mcp: {
    title: 'MCP connections',
    description: 'Connect MCP servers once; every backend and automation can use their tools through BOSS'
  },
  mobile: {
    title: 'Mobile access',
    description: 'Review threads and automations from your phone over your tailnet or an SSH tunnel.'
  },
  telegram: {
    title: 'Telegram',
    description: 'Send messages to your own bot and have them delivered into a thread of your choice.'
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
  },
  updates: {
    title: 'Updates',
    description: 'Choose which BOSS releases this copy installs.'
  }
}

const THEME_CATEGORIES = ['BOSS', 'Community', 'Accessibility'] as const

/** Which releases this copy installs.
 *
 *  Beta is for people who build BOSS with BOSS: it carries whatever landed on
 *  main last night, so a change can be tried in the real app without cutting a
 *  release by hand. Its cost is that a bad night ships a bad build. */
function UpdateSettings(): React.JSX.Element {
  const [status, setStatus] = useState<UpdateStatus | null>(null)

  useEffect(() => {
    void window.boss.updateStatus().then(setStatus).catch(() => {})
    return window.boss.onUpdateChanged(setStatus)
  }, [])

  const channel = status?.channel ?? 'stable'
  return (
    <div className="settings-group-stack">
      <section className="settings-card">
        <SettingsRow
          title="Release channel"
          description={
            channel === 'beta'
              ? 'Nightly builds from main. Signed and notarized, but less tested than a release.'
              : 'Released versions only. This is the right choice unless you are working on BOSS itself.'
          }
        >
          <Select
            value={channel}
            onChange={(event) => {
              void window.boss.updateChannelSet(event.target.value as UpdateChannel).then(setStatus)
            }}
          >
            <option value="stable">Stable</option>
            <option value="beta">Beta</option>
          </Select>
        </SettingsRow>
        <SettingsRow
          title="This copy"
          description={
            status?.error
              ? status.error
              : status?.ready
                ? `BOSS ${status.latestVersion} is staged and applies at the next quit.`
                : status?.available
                  ? `BOSS ${status.latestVersion} is available.`
                  : 'Up to date.'
          }
        >
          <span className="settings-row-hint">{status?.currentVersion ?? '—'}</span>
          <Button
            onClick={() => void window.boss.updateCheck().then(setStatus)}
            disabled={status?.checking}
          >
            {status?.checking ? 'Checking…' : 'Check now'}
          </Button>
        </SettingsRow>
      </section>
      <CliSettings />
    </div>
  )
}

/** The `boss` shell command.
 *
 *  A symlink into the bundle rather than a copied script, so it keeps working
 *  after an update replaces the app. The row states what is actually on disk —
 *  installing is the only action here that changes anything. */
function CliSettings(): React.JSX.Element {
  const [status, setStatus] = useState<CliStatus | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.boss.cliStatus().then(setStatus).catch(() => {})
  }, [])

  function run(action: () => Promise<CliStatus>): void {
    setBusy(true)
    void action()
      .then(setStatus)
      .catch(() => {})
      .finally(() => setBusy(false))
  }

  const description = status?.error
    ? status.error
    : !status?.available
      ? 'A packaged copy of BOSS installs this. A development build has no stable location to point it at.'
      : status.conflict
        ? `Something else already owns ${status.path}. BOSS will not replace a command it did not install.`
        : status.installed
          ? `Installed at ${status.path}. Run \`boss .\` in any folder to open it as a project.`
          : 'Run `boss .` in a terminal to open that folder as a BOSS project, creating the project if the folder is not one yet.'

  return (
    <section className="settings-card">
      <SettingsRow title="The `boss` command" description={description}>
        {status?.installed ? (
          <Button onClick={() => run(() => window.boss.cliUninstall())} disabled={busy}>
            {busy ? 'Removing…' : 'Remove'}
          </Button>
        ) : (
          <Button
            onClick={() => run(() => window.boss.cliInstall())}
            disabled={busy || !status?.available || status?.conflict}
          >
            {busy ? 'Installing…' : 'Install'}
          </Button>
        )}
      </SettingsRow>
    </section>
  )
}

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

/** Where this backend's CLI lives, when PATH cannot find it.
 *
 *  BOSS imports the login shell's PATH at startup, which covers nvm, bun, and Homebrew
 *  installs that a Finder-launched app would otherwise miss. A non-POSIX login shell
 *  (nushell, fish) defeats that probe, and no list of fallback directories covers every
 *  layout — so this is the manual way out of "not installed" on a machine where the CLI
 *  plainly works in a terminal.
 *
 *  Empty means "use PATH". Saving re-probes, so the row's availability badge answers
 *  immediately instead of staying stale until the next launch. */
function BackendBinaryPath({
  backend,
  path,
  onSaved
}: {
  // Only rendered for a backend that spawns a CLI: `command` is what gets resolved.
  backend: BackendDescriptor & { command: string }
  path: string
  onSaved: (paths: Partial<Record<BackendId, string>>) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(path)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // The stored value arrives after the first render, and can change when another
  // backend's save returns the whole set. Do not clobber a path being typed.
  useEffect(() => {
    setDraft(path)
  }, [path])

  const save = async (): Promise<void> => {
    setError(null)
    try {
      onSaved(await OpenCode.setBackendBinary(backend.id, draft))
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the location.')
    }
  }

  return (
    <div className="settings-runtime-path">
      <label>
        <span>Location</span>
        <input
          className="settings-input"
          value={draft}
          spellCheck={false}
          placeholder={`Found on PATH — or /usr/local/bin/${backend.command}`}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void save()
          }}
        />
      </label>
      <Button size="small" variant="ghost" disabled={draft === path} onClick={() => void save()}>
        {saved ? 'Saved' : 'Save'}
      </Button>
      {error ? <StatusBadge tone="danger">{error}</StatusBadge> : null}
    </div>
  )
}

/** Stop a backend's server so the next request starts a fresh one.
 *
 *  A server reads its credentials once, when it starts. Signing in to another
 *  account therefore leaves the running server using the account that signed
 *  out, and every request fails as unauthorized while the CLI itself is signed
 *  in correctly. This is the way out of that without quitting BOSS. */
function RestartBackendServer({ backend }: { backend: BackendDescriptor }): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const [restarting, setRestarting] = useState(false)
  const [done, setDone] = useState(false)

  const restart = async (): Promise<void> => {
    setError(null)
    setRestarting(true)
    try {
      await restartBackend(backend.id)
      setDone(true)
      setTimeout(() => setDone(false), 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not restart the server.')
    } finally {
      setRestarting(false)
    }
  }

  return (
    <div className="settings-runtime-restart">
      <Button
        size="small"
        variant="ghost"
        disabled={!backend.available || restarting}
        title="Stop this agent server so the next message starts a fresh one. Use after signing in to a different account."
        onClick={() => void restart()}
      >
        {restarting ? 'Restarting…' : done ? 'Restarted' : 'Restart server'}
      </Button>
      {error ? <StatusBadge tone="danger">{error}</StatusBadge> : null}
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

/** API keys stay blank because their values never leave main-process secure storage. */
function LabConnectionEditor({
  connection,
  onCancel,
  onChange,
  onSaved
}: {
  connection?: LabConnection
  onCancel: () => void
  onChange: (settings: LabConnectionsSettings) => void
  onSaved: () => Promise<void>
}): React.JSX.Element {
  const [name, setName] = useState(connection?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? '')
  const [apiKey, setApiKey] = useState('')
  const [manualModels, setManualModels] = useState(connection?.manualModels.join('\n') ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (clearApiKey = false): Promise<void> => {
    setError(null)
    setSaving(true)
    try {
      const settings = await OpenCode.saveLabConnection({
        ...(connection ? { id: connection.id } : {}),
        name,
        baseUrl,
        manualModels: manualModels.split(/[,\n]/).map((model) => model.trim()).filter(Boolean),
        ...(apiKey ? { apiKey } : {}),
        ...(clearApiKey ? { clearApiKey: true } : {})
      })
      onChange(settings)
      await onSaved()
      onCancel()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save the Lab API connection.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="lab-connection-editor" aria-label={connection ? `Edit ${connection.name} Lab connection` : 'Add Lab connection'}>
      <div className="lab-connection-fields">
        <label>
          <span>Connection name</span>
          <input autoFocus className="settings-input" aria-label="Lab connection name" value={name} placeholder="OpenAI, OpenRouter, Ollama…" onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          <span>OpenAI-compatible endpoint</span>
          <input className="settings-input" aria-label="Lab endpoint URL" value={baseUrl} placeholder="https://api.openai.com/v1" spellCheck={false} onChange={(event) => setBaseUrl(event.target.value)} />
        </label>
        <label>
          <span>API key <em>optional for local endpoints</em></span>
          <input className="settings-input" aria-label="Lab API key" type="password" value={apiKey} placeholder={connection?.apiKeyConfigured ? 'Saved securely — enter a replacement' : 'Paste a key to store securely'} autoComplete="new-password" onChange={(event) => setApiKey(event.target.value)} />
        </label>
        <label className="lab-models-field">
          <span>Manual models <em>optional fallback, one per line</em></span>
          <textarea className="settings-input" aria-label="Lab manual models" value={manualModels} placeholder="gpt-5.1-codex" spellCheck={false} onChange={(event) => setManualModels(event.target.value)} />
        </label>
      </div>
      <p className="lab-connection-help">Saving tests the endpoint and imports models from <code>/models</code>. Add IDs manually when an API does not expose a model catalogue.</p>
      <div className="lab-connection-actions">
        <Button size="small" disabled={saving || !name.trim() || !baseUrl.trim()} onClick={() => void save()}>{saving ? 'Testing…' : 'Save & test'}</Button>
        <Button size="small" variant="ghost" disabled={saving} onClick={onCancel}>Cancel</Button>
        {connection?.apiKeyConfigured ? <Button size="small" variant="ghost" disabled={saving} onClick={() => void save(true)}>Clear saved key</Button> : null}
        {error ? <StatusBadge tone="danger">{error}</StatusBadge> : null}
      </div>
    </section>
  )
}

function LabConnections({ onSaved }: { onSaved: () => Promise<void> }): React.JSX.Element {
  const [settings, setSettings] = useState<LabConnectionsSettings | null>(null)
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void OpenCode.labConnections().then(setSettings).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : 'Could not load Lab API connections.')
    })
  }, [])

  const remove = (connection: LabConnection): void => {
    appStore.setState({
      confirm: {
        title: `Remove ${connection.name}?`,
        message: 'Lab threads using one of its models will need another model before they can run.',
        confirmLabel: 'Remove connection',
        destructive: true,
        action: () => {
          void OpenCode.deleteLabConnection(connection.id)
            .then(async (next) => {
              setSettings(next)
              await onSaved()
            })
            .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Could not remove the connection.'))
        }
      }
    })
  }

  const selected = editing && editing !== 'new' ? settings?.connections.find((connection) => connection.id === editing) : undefined
  return (
    <section className="lab-connections" aria-label="Lab API connections">
      <header className="lab-connections-heading">
        <div>
          <h3>Lab API connections</h3>
          <p>Add local or cloud OpenAI-compatible APIs. Each connection keeps its own key and model list.</p>
        </div>
        <Button size="small" disabled={editing !== null} onClick={() => setEditing('new')}>Add connection</Button>
      </header>
      {error ? <StatusBadge tone="danger">{error}</StatusBadge> : null}
      {settings?.connections.length === 0 && editing === null ? <div className="lab-connections-empty">No APIs configured. Add a connection to make Lab usable.</div> : null}
      <div className="lab-connections-list">
        {settings?.connections.map((connection) => (
          <article className="lab-connection-card" aria-label={`${connection.name} Lab connection`} key={connection.id}>
            <div className="lab-connection-card-copy">
              <strong>{connection.name}</strong>
              <code>{connection.baseUrl}</code>
              <small>{connection.models.length ? `${connection.models.length} model${connection.models.length === 1 ? '' : 's'}: ${connection.models.slice(0, 3).map((model) => model.name || model.id).join(', ')}${connection.models.length > 3 ? '…' : ''}` : 'No models discovered or added yet'}</small>
            </div>
            <div className="lab-connection-statuses">
              <StatusBadge tone={connection.healthy ? 'success' : 'danger'}>{connection.healthy ? 'Ready' : 'Unavailable'}</StatusBadge>
              <StatusBadge tone={connection.apiKeyConfigured ? 'accent' : 'neutral'}>{connection.apiKeyConfigured ? 'Key saved' : 'No key'}</StatusBadge>
            </div>
            <div className="lab-connection-card-actions">
              <Button size="small" variant="ghost" disabled={editing !== null} onClick={() => setEditing(connection.id)}>Edit</Button>
              <Button size="small" variant="ghost" disabled={editing !== null} onClick={() => remove(connection)}>Remove</Button>
            </div>
          </article>
        ))}
      </div>
      {editing ? (
        <LabConnectionEditor
          key={editing}
          connection={selected}
          onCancel={() => setEditing(null)}
          onChange={setSettings}
          onSaved={onSaved}
        />
      ) : null}
    </section>
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
  const subscriptionUsage = useStore(appStore, (s) => s.subscriptionUsage)
  const backendModels = useStore(appStore, (s) => s.backendModels ?? {})
  const backendModelsLoading = useStore(appStore, (s) => s.backendModelsLoading ?? false)
  const defaultModels = useStore(appStore, (s) => s.defaultModels ?? {})
  const qaDefault = useStore(appStore, (s) => s.qaDefault)
  const computerUse = useStore(appStore, (s) => s.computerUse)
  const computerUsePerms = useStore(appStore, (s) => s.computerUsePerms)
  const terminalStartLocation = useStore(appStore, (s) => s.terminalStartLocation)
  const viewMode = useStore(appStore, (s) => s.viewMode)
  const uiFontSize = useStore(appStore, (s) => s.uiFontSize)
  const uiDensity = useStore(appStore, (s) => s.uiDensity)
  const [section, setSection] = useState<SettingsSection>('connections')
  const [currentTheme, setCurrentTheme] = useState(loadTheme)
  const [typography, setTypography] = useState(loadTypography)
  const [query, setQuery] = useState('')
  const matches = useMemo(() => searchSettings(query), [query])
  const [worktreeSettings, setWorktreeSettings] = useState<WorktreeSettings | null>(null)
  const [threadTitleSettings, setThreadTitleSettings] = useState<ThreadTitleSettings | null>(null)
  const [sandboxSettings, setSandboxSettings] = useState<SandboxSettings | null>(null)
  const [backendBins, setBackendBins] = useState<Partial<Record<BackendId, string>>>({})

  useEffect(() => {
    if (!open) return
    void OpenCode.worktreeSettings().then(setWorktreeSettings).catch(() => {})
    void OpenCode.threadTitleSettings().then(setThreadTitleSettings).catch(() => {})
    void OpenCode.sandboxSettings().then(setSandboxSettings).catch(() => {})
    void OpenCode.backendBinaries().then(setBackendBins).catch(() => {})
    void refreshBackendAuth()
    void refreshSubscriptionUsage()
    void refreshBackendModels()
    void refreshQaDefault()
  }, [open])

  // A saved location changes what the next spawn resolves, so re-probe: without this
  // a backend that now works keeps showing the "not installed" reason it was saved to fix.
  const saveBackendBins = (paths: Partial<Record<BackendId, string>>): void => {
    setBackendBins(paths)
    void loadEngine()
  }

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
          <div className="settings-search">
            <SearchIcon size={13} />
            <input
              value={query}
              placeholder="Search settings"
              aria-label="Search settings"
              spellCheck={false}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setQuery('')
                // Enter takes the first offer, so a search can be finished without the mouse.
                if (event.key === 'Enter' && matches.length) {
                  setSection(matches[0].section)
                  setQuery('')
                }
              }}
            />
          </div>
          {query.trim() ? (
            <nav className="settings-nav-results" aria-label="Search results">
              {matches.length ? matches.map((match: SettingsMatch) => (
                <button
                  key={`${match.section}:${match.label}`}
                  onClick={() => {
                    setSection(match.section)
                    setQuery('')
                  }}
                >
                  <span>{match.label}</span>
                  <small>{SECTION_LABELS[match.section as SettingsSection]}</small>
                </button>
              )) : <p className="settings-nav-empty">Nothing matches “{query.trim()}”.</p>}
            </nav>
          ) : (
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
          )}
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
                        title={backend.available ? backend.versionWarning || backend.description : backend.unavailableReason}
                      >
                        <BackendBadge backendId={backend.id} />
                        <span>
                          <strong>{backend.label}</strong>
                          {/* The warning replaces the version here rather than
                              sitting beside it: it already names the version,
                              and this line only has room for one of them. */}
                          <small className={backend.available && backend.versionWarning ? 'backend-version-warning' : undefined}>
                            {backend.available
                              ? backend.versionWarning || backend.version || 'Available'
                              : backend.unavailableReason}
                          </small>
                        </span>
                        {defaultBackend === backend.id ? <em>Default</em> : null}
                      </button>
                    ))}
                  </div>
                </section>

                <section className="settings-card settings-card-list">
                  <SettingsRow
                    title="Auto-name threads"
                    description="Generate a short name from the first request, using a small model call when supported and a local fallback otherwise."
                  >
                    <label className="settings-computer-toggle">
                      <input
                        type="checkbox"
                        aria-label="Auto-name threads"
                        checked={threadTitleSettings?.autoNameFromFirstPrompt ?? false}
                        onChange={(event) => {
                          const autoNameFromFirstPrompt = event.target.checked
                          setThreadTitleSettings({ autoNameFromFirstPrompt })
                          void OpenCode.setThreadTitleSettings(autoNameFromFirstPrompt)
                            .then(setThreadTitleSettings)
                            .catch(() => setThreadTitleSettings((current) => current ? { ...current, autoNameFromFirstPrompt: !autoNameFromFirstPrompt } : current))
                        }}
                      />
                      <span>{threadTitleSettings?.autoNameFromFirstPrompt ? 'On' : 'Off'}</span>
                    </label>
                  </SettingsRow>
                  <SettingsRow
                    title="Agent network access"
                    description="Let a sandboxed agent reach the network. Off blocks gh, npm, and curl, so an agent cannot open a pull request. Plan mode stays offline either way. This applies to Codex, the only backend that sandboxes today."
                  >
                    <label className="settings-computer-toggle">
                      <input
                        type="checkbox"
                        aria-label="Agent network access"
                        checked={sandboxSettings?.networkAccess ?? true}
                        onChange={(event) => {
                          const networkAccess = event.target.checked
                          setSandboxSettings({ networkAccess })
                          void OpenCode.setSandboxSettings(networkAccess)
                            .then(setSandboxSettings)
                            .catch(() => setSandboxSettings((current) => current ? { ...current, networkAccess: !networkAccess } : current))
                        }}
                      />
                      <span>{sandboxSettings?.networkAccess ?? true ? 'On' : 'Off'}</span>
                    </label>
                  </SettingsRow>
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
                            {/* This row is where someone comes to repoint a
                                binary, so the warning sits under the version
                                rather than replacing it. */}
                            {backend.available && backend.versionWarning ? (
                              <small className="backend-version-warning">{backend.versionWarning}</small>
                            ) : null}
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

                        <div className="settings-connection-actions">
                          {backend.id !== 'lab' ? (
                            <>
                              <Button size="small" disabled={!backend.available} onClick={() => openBackendLogin(backend.id)}>
                                {hasCloudAccount ? 'Manage' : 'Add account'}
                              </Button>
                              <RestartBackendServer backend={backend} />
                            </>
                          ) : null}
                        </div>
                        {/* Full width, below the columns. A filesystem path does not fit the
                            narrowest column of a four-column grid — the placeholder alone is
                            longer than the field was, so the value being typed was never
                            readable. */}
                        {backend.command ? (
                          <BackendBinaryPath
                            backend={{ ...backend, command: backend.command }}
                            path={backendBins[backend.id] ?? ''}
                            onSaved={saveBackendBins}
                          />
                        ) : null}
                        {backend.id === 'lab' ? <LabConnections onSaved={async () => {
                          await loadEngine()
                          await refreshBackendModels()
                        }} /> : null}
                      </div>
                    )
                  })}
                </section>
              </div>
            ) : null}

            {section === 'usage' ? (
              <div className="settings-group-stack">
                <div className="settings-usage-toolbar">
                  <div>
                    <strong>Provider-reported balances</strong>
                    <p>These values come from each subscription provider, not from BOSS activity totals.</p>
                  </div>
                  <Button size="small" onClick={() => void refreshSubscriptionUsage()}>Refresh usage</Button>
                </div>
                <div className="settings-usage-grid">
                  {(['opencode', 'codex', 'claude'] as const).map((backendId) => {
                    const backend = backends.find((item) => item.id === backendId)
                    const usage = subscriptionUsage.find((item) => item.backendId === backendId)
                    const title = backendId === 'opencode' ? 'OpenCode Go' : backend?.label ?? backendId
                    return (
                      <section className="settings-usage-card" aria-label={`${title} usage`} key={backendId}>
                        <header>
                          <BackendBadge backendId={backendId} />
                          <div>
                            <h2>{title}</h2>
                            {usage?.plan && usage.plan !== title ? <small>{usage.plan}</small> : null}
                          </div>
                        </header>
                        <SubscriptionUsage usage={usage} />
                      </section>
                    )
                  })}
                </div>
                <section className="settings-card settings-usage-note">
                  <h2>Pi uses provider accounts</h2>
                  <p>Pi has no subscription balance of its own. Its limits belong to the ChatGPT, Claude, OpenCode Go, or API provider credential selected for the model.</p>
                </section>
              </div>
            ) : null}

            {section === 'mcp' ? <McpSettings /> : null}

            {section === 'mobile' ? <MobileSettings /> : null}

            {section === 'telegram' ? <TelegramSettings /> : null}

            {section === 'collaboration' ? (
              <div className="settings-group-stack">
                <section className="settings-card settings-card-list">
                  <SettingsRow title="Agent access" description="Applies to every project without its own setting below. OpenCode, Pi, Codex CLI, and Claude Code threads can use the thread tools.">
                  <Select
                    value={threadBus?.defaultPolicy ?? 'off'}
                    onChange={(event) => void setThreadBusDefaultPolicy(event.target.value as CollaborationPolicy)}
                  >
                    <option value="off">Off</option>
                    <option value="read">Read-only</option>
                    <option value="collaborate">Read and send</option>
                  </Select>
                  </SettingsRow>
                  {threadBus?.projectId && threadBus.projectId !== 'global' ? (
                    <SettingsRow
                      title={`This project: ${projectName(threadBus.projectPath)}`}
                      description={threadBus.source === 'default' ? 'Following the setting above.' : 'Set for this project only.'}
                    >
                    <Select
                      value={threadBus.source === 'default' ? 'default' : threadBus.policy}
                      onChange={(event) => void setThreadBusPolicy(
                        event.target.value === 'default' ? null : event.target.value as CollaborationPolicy,
                        threadBus.projectId
                      )}
                    >
                      <option value="default">Use default</option>
                      <option value="off">Off</option>
                      <option value="read">Read-only</option>
                      <option value="collaborate">Read and send</option>
                    </Select>
                    </SettingsRow>
                  ) : null}
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
                {threadBus?.overrides.length ? (
                  <section className="settings-card settings-card-list">
                    <div className="settings-section-title">Projects with their own setting</div>
                    {threadBus.overrides.map((override) => (
                      <SettingsRow
                        key={override.projectId}
                        title={projectName(override.projectPath)}
                        description={override.projectPath || 'Path not known until this project is opened again.'}
                      >
                      <Select
                        value={override.policy}
                        onChange={(event) => void setThreadBusPolicy(
                          event.target.value === 'default' ? null : event.target.value as CollaborationPolicy,
                          override.projectId
                        )}
                      >
                        <option value="default">Use default</option>
                        <option value="off">Off</option>
                        <option value="read">Read-only</option>
                        <option value="collaborate">Read and send</option>
                      </Select>
                      </SettingsRow>
                    ))}
                  </section>
                ) : null}
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
              <>
              <section className="settings-card">
                <div className="settings-card-heading">
                  <div>
                    <h2>Workspace layout</h2>
                    <p>How threads are shown. Your panes are kept either way, so switching back restores the layout you arranged.</p>
                  </div>
                </div>
                <div className="viewmode-grid" role="radiogroup" aria-label="Workspace layout">
                  {VIEW_MODES.map((mode) => (
                    <button
                      key={mode.id}
                      role="radio"
                      aria-checked={viewMode === mode.id}
                      className={`viewmode-option ${viewMode === mode.id ? 'active' : ''}`}
                      onClick={() => setViewMode(mode.id)}
                    >
                      <span className="viewmode-preview">{mode.silhouette}</span>
                      <span className="viewmode-copy">
                        <strong>{mode.label}</strong>
                        <small>{mode.description}</small>
                      </span>
                    </button>
                  ))}
                </div>
              </section>
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
              <section className="settings-card settings-group-stack">
                <div className="settings-card-heading">
                  <div>
                    <h2>Type &amp; density</h2>
                    <p>Choose the app’s typefaces and scale, then tune reading, terminal and interface spacing independently.</p>
                  </div>
                </div>
                <SettingsRow title="Interface font" description="Used for everything except code, diffs and the terminal.">
                  <Select value={typography.uiFont} onChange={(event) => setTypography(saveTypography({ ...typography, uiFont: event.target.value }))}>
                    {UI_FONTS.map((font) => <option key={font.id} value={font.id}>{font.label}</option>)}
                  </Select>
                </SettingsRow>
                <SettingsRow title="Monospace font" description="Code, diffs and the terminal. A face the machine does not have falls back to the system's own.">
                  <Select value={typography.monoFont} onChange={(event) => setTypography(saveTypography({ ...typography, monoFont: event.target.value }))}>
                    {MONO_FONTS.map((font) => <option key={font.id} value={font.id}>{font.label}</option>)}
                  </Select>
                </SettingsRow>
                <SettingsRow title="Base font size" description="Sizes the app chrome. Conversation and terminal text keep their individual sizes.">
                  <Select
                    aria-label="Base font size"
                    value={uiFontSize}
                    onChange={(event) => setUiFontSize(event.target.value as UiFontSize)}
                  >
                    <option value="small">Small</option>
                    <option value="default">Default</option>
                    <option value="large">Large</option>
                  </Select>
                </SettingsRow>
                <SettingsRow title="Reading size" description={`How large a reply is drawn. ${typography.readingSize}px.`}>
                  <div className="settings-size-stepper">
                    <Button size="small" variant="ghost" disabled={typography.readingSize <= READING_SIZE.min} onClick={() => setTypography(stepReadingSize(-1))}>−</Button>
                    <span>{typography.readingSize}px</span>
                    <Button size="small" variant="ghost" disabled={typography.readingSize >= READING_SIZE.max} onClick={() => setTypography(stepReadingSize(1))}>+</Button>
                  </div>
                </SettingsRow>
                <SettingsRow title="Terminal size" description={`How large a terminal is drawn. ${typography.terminalSize}px.`}>
                  <div className="settings-size-stepper">
                    <Button size="small" variant="ghost" disabled={typography.terminalSize <= TERMINAL_SIZE.min} onClick={() => setTypography(stepTerminalSize(-1))}>−</Button>
                    <span>{typography.terminalSize}px</span>
                    <Button size="small" variant="ghost" disabled={typography.terminalSize >= TERMINAL_SIZE.max} onClick={() => setTypography(stepTerminalSize(1))}>+</Button>
                  </div>
                </SettingsRow>
                <SettingsRow title="UI density" description="Compact tightens controls and common navigation rows to fit more on screen.">
                  <Select
                    aria-label="UI density"
                    value={uiDensity}
                    onChange={(event) => setUiDensity(event.target.value as UiDensity)}
                  >
                    <option value="comfortable">Comfortable</option>
                    <option value="compact">Compact</option>
                  </Select>
                </SettingsRow>
              </section>
              </>
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

            {section === 'updates' ? <UpdateSettings /> : null}
          </div>
        </main>
      </div>
    </div>
  )
}
