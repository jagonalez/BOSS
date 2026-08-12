import React, { useEffect, useState } from 'react'
import { useStore, appStore } from '../state/AppState'
import type { McpConnectionInput, McpConnectionView, McpImportCandidate, McpTransport } from '@shared/mcp'
import { OpenCode } from '../lib/opencode'
import { refreshMcpConnections } from '../lib/actions'
import { Button, StatusBadge, Select } from './ui'

function parsePairs(text: string): Record<string, string> | undefined {
  const pairs: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const index = trimmed.indexOf('=')
    if (index <= 0) continue
    pairs[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim()
  }
  return Object.keys(pairs).length > 0 ? pairs : undefined
}

function pairsText(pairs: Record<string, string> | undefined): string {
  if (!pairs) return ''
  return Object.entries(pairs).map(([key, value]) => `${key}=${value}`).join('\n')
}

const STATUS_TONE = { connected: 'success', starting: 'accent', error: 'danger', disabled: 'neutral' } as const
const STATUS_LABEL = { connected: 'Connected', starting: 'Starting…', error: 'Error', disabled: 'Off' } as const

interface FormState {
  id?: string
  name: string
  transport: McpTransport
  command: string
  args: string
  env: string
  url: string
  headers: string
}

const EMPTY_FORM: FormState = { name: '', transport: 'stdio', command: '', args: '', env: '', url: '', headers: '' }

function ConnectionForm({ initial, onClose }: { initial: FormState; onClose: () => void }): React.JSX.Element {
  const [form, setForm] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const patch = (partial: Partial<FormState>): void => setForm((current) => ({ ...current, ...partial }))

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    const input: McpConnectionInput = {
      name: form.name,
      transport: form.transport,
      command: form.transport === 'stdio' ? form.command.trim() : undefined,
      args: form.transport === 'stdio' && form.args.trim() ? form.args.trim().split(/\s+/) : undefined,
      env: form.transport === 'stdio' ? parsePairs(form.env) : undefined,
      url: form.transport === 'http' ? form.url.trim() : undefined,
      headers: form.transport === 'http' ? parsePairs(form.headers) : undefined
    }
    try {
      if (form.id) await OpenCode.mcpUpdate(form.id, input)
      else await OpenCode.mcpAdd(input)
      await refreshMcpConnections()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mcp-form">
      <label className="settings-row">
        <span className="settings-row-label">Name</span>
        <input className="settings-input" value={form.name} placeholder="Slack" onChange={(e) => patch({ name: e.target.value })} />
      </label>
      <label className="settings-row">
        <span className="settings-row-label">Type</span>
        <Select value={form.transport} onChange={(e) => patch({ transport: e.target.value as McpTransport })}>
          <option value="stdio">Local command (stdio)</option>
          <option value="http">Remote server (HTTP)</option>
        </Select>
      </label>
      {form.transport === 'stdio' ? (
        <>
          <label className="settings-row">
            <span className="settings-row-label">Command</span>
            <input className="settings-input" value={form.command} placeholder="npx" onChange={(e) => patch({ command: e.target.value })} />
          </label>
          <label className="settings-row">
            <span className="settings-row-label">Arguments</span>
            <input className="settings-input" value={form.args} placeholder="-y @upstash/context7-mcp@latest" onChange={(e) => patch({ args: e.target.value })} />
          </label>
          <label className="settings-row mcp-pairs-row">
            <span className="settings-row-label">Environment</span>
            <textarea
              className="settings-input mcp-pairs"
              rows={2}
              value={form.env}
              placeholder={'SLACK_BOT_TOKEN=xoxb-…\nONE_PER_LINE=value'}
              onChange={(e) => patch({ env: e.target.value })}
            />
          </label>
        </>
      ) : (
        <>
          <label className="settings-row">
            <span className="settings-row-label">URL</span>
            <input className="settings-input" value={form.url} placeholder="https://mcp.example.com/mcp" onChange={(e) => patch({ url: e.target.value })} />
          </label>
          <label className="settings-row mcp-pairs-row">
            <span className="settings-row-label">Headers</span>
            <textarea
              className="settings-input mcp-pairs"
              rows={2}
              value={form.headers}
              placeholder={'Authorization=Bearer …\nONE_PER_LINE=value'}
              onChange={(e) => patch({ headers: e.target.value })}
            />
          </label>
        </>
      )}
      <div className="mcp-form-hint">Secret values are stored encrypted with the system keychain. Saved secrets show as masked; leave them masked to keep them.</div>
      {error ? <div className="automation-error">{error}</div> : null}
      <div className="automation-editor-actions">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={saving || !form.name.trim()} onClick={() => void save()}>
          {saving ? 'Saving…' : form.id ? 'Save changes' : 'Add connection'}
        </Button>
      </div>
    </div>
  )
}

function ConnectionCard({ view, onEdit }: { view: McpConnectionView; onEdit: () => void }): React.JSX.Element {
  const [showTools, setShowTools] = useState(false)
  const { connection } = view
  const target = connection.transport === 'stdio'
    ? [connection.command, ...(connection.args ?? [])].filter(Boolean).join(' ')
    : connection.url ?? ''

  const act = async (action: () => Promise<unknown>): Promise<void> => {
    try {
      await action()
    } catch (err) {
      appStore.setState({ lastError: err instanceof Error ? err.message : String(err) })
    }
    await refreshMcpConnections()
  }

  return (
    <div className="settings-connection-card mcp-card">
      <div className="settings-connection-header">
        <h2>{connection.name}</h2>
        <div>
          <StatusBadge tone={STATUS_TONE[view.status]}>{STATUS_LABEL[view.status]}</StatusBadge>
        </div>
      </div>
      <div className="settings-connection-detail" title={target}>{target}</div>
      {view.error ? <div className="automation-error">{view.error}</div> : null}
      {view.status === 'connected' ? (
        <div className="mcp-tools-line">
          <button className="mcp-tools-toggle" onClick={() => setShowTools((value) => !value)}>
            {view.tools.length} tool{view.tools.length === 1 ? '' : 's'} {showTools ? '▾' : '▸'}
          </button>
          {showTools ? (
            <ul className="mcp-tools-list">
              {view.tools.map((tool) => <li key={tool.name} title={tool.description}>{tool.name}</li>)}
            </ul>
          ) : null}
        </div>
      ) : null}
      <div className="settings-connection-actions">
        <Button size="small" onClick={() => void act(() => OpenCode.mcpUpdate(connection.id, { enabled: !connection.enabled }))}>
          {connection.enabled ? 'Disable' : 'Enable'}
        </Button>
        <Button size="small" variant="ghost" onClick={onEdit}>Edit</Button>
        <Button
          size="small"
          variant="ghost"
          onClick={() =>
            appStore.setState({
              confirm: {
                title: 'Remove connection?',
                message: `Remove "${connection.name}"? Agents lose its tools immediately, and its stored secrets are deleted.`,
                confirmLabel: 'Remove',
                destructive: true,
                action: () => void act(() => OpenCode.mcpRemove(connection.id))
              }
            })
          }
        >
          Remove
        </Button>
      </div>
    </div>
  )
}

function ImportPanel({ onDone }: { onDone: () => void }): React.JSX.Element {
  const [candidates, setCandidates] = useState<McpImportCandidate[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    void OpenCode.mcpImportScan().then(setCandidates).catch(() => setCandidates([]))
  }, [])

  const importCandidate = async (candidate: McpImportCandidate): Promise<void> => {
    setBusy(candidate.input.name)
    try {
      await OpenCode.mcpAdd(candidate.input)
      await refreshMcpConnections()
      setCandidates((current) => current?.filter((item) => item !== candidate) ?? null)
    } catch (err) {
      appStore.setState({ lastError: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(null)
    }
  }

  if (candidates === null) return <div className="command-empty">Scanning Claude Code, Claude Desktop, and Codex configs…</div>
  const fresh = candidates.filter((candidate) => !candidate.alreadyConfigured)
  if (fresh.length === 0) {
    return (
      <div className="command-empty">
        No importable servers found. Servers already in R.A.L.F. are skipped.
        <div><Button size="small" variant="ghost" onClick={onDone}>Close</Button></div>
      </div>
    )
  }
  return (
    <div className="mcp-import-list">
      {fresh.map((candidate) => (
        <div className="mcp-import-row" key={`${candidate.source}:${candidate.input.name}`}>
          <div className="command-session-main">
            <strong>{candidate.input.name}</strong>
            <small>{candidate.source} · {candidate.input.transport === 'stdio'
              ? [candidate.input.command, ...(candidate.input.args ?? [])].join(' ')
              : candidate.input.url}</small>
          </div>
          <Button size="small" disabled={busy === candidate.input.name} onClick={() => void importCandidate(candidate)}>
            {busy === candidate.input.name ? 'Importing…' : 'Import'}
          </Button>
        </div>
      ))}
      <div className="automation-editor-actions"><Button variant="ghost" size="small" onClick={onDone}>Done</Button></div>
    </div>
  )
}

export function McpSettings(): React.JSX.Element {
  const connections = useStore(appStore, (s) => s.mcpConnections)
  const [form, setForm] = useState<FormState | null>(null)
  const [importing, setImporting] = useState(false)

  useEffect(() => {
    void refreshMcpConnections()
  }, [])

  return (
    <div className="settings-group-stack">
      <section className="settings-card">
        <div className="settings-card-heading">
          <h2>MCP connections</h2>
          <p>
            Connect MCP servers once, in R.A.L.F. — every backend and every automation can then use their tools.
            Claude Code sees them directly; other agents use ralf_mcp_list and ralf_mcp_call.
          </p>
        </div>
        <div className="settings-connection-actions">
          <Button size="small" onClick={() => { setImporting(false); setForm({ ...EMPTY_FORM }) }}>Add connection…</Button>
          <Button size="small" variant="ghost" onClick={() => { setForm(null); setImporting(true) }}>Import from other apps…</Button>
        </div>
        {form ? <ConnectionForm initial={form} onClose={() => setForm(null)} /> : null}
        {importing ? <ImportPanel onDone={() => setImporting(false)} /> : null}
      </section>
      <section className="settings-card settings-card-list">
        {connections.length > 0 ? (
          connections.map((view) => (
            <ConnectionCard
              key={view.connection.id}
              view={view}
              onEdit={() => {
                setImporting(false)
                setForm({
                  id: view.connection.id,
                  name: view.connection.name,
                  transport: view.connection.transport,
                  command: view.connection.command ?? '',
                  args: (view.connection.args ?? []).join(' '),
                  env: pairsText(view.connection.env),
                  url: view.connection.url ?? '',
                  headers: pairsText(view.connection.headers)
                })
              }}
            />
          ))
        ) : (
          <div className="command-empty">No MCP connections yet. Add one, or import from Claude Code, Claude Desktop, or Codex.</div>
        )}
      </section>
    </div>
  )
}
