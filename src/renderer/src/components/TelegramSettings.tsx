import React, { useEffect, useState } from 'react'
import type { SessionInfo } from '@shared/opencode'
import type { TelegramSettingsPatch, TelegramStatus } from '@shared/telegram'
import { appStore, useStore } from '../state/AppState'
import { OpenCode } from '../lib/opencode'
import { Button, SettingsRow, StatusBadge } from './ui'

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return new Date(ts).toLocaleString()
}

/**
 * Inbound messaging over Telegram. Off until every piece is in place: a bot
 * token from @BotFather, the thread messages land in, and the Enable switch.
 * The first chat that writes the bot pairs itself, so setup never needs a
 * chat id typed by hand.
 */
export function TelegramSettings(): React.JSX.Element {
  const sessions = useStore(appStore, (s) => s.sessions)
  const [status, setStatus] = useState<TelegramStatus | null>(null)
  const [tokenInput, setTokenInput] = useState('')
  const [chatsInput, setChatsInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void OpenCode.telegramStatus().then((next) => {
      if (!live) return
      setStatus(next)
      setChatsInput(next.allowedChatIds.join(', '))
    }).catch(() => {})
    return () => {
      live = false
    }
  }, [])

  // The poll loop lives in main and changes state on its own; ask while open.
  const enabled = Boolean(status?.enabled)
  useEffect(() => {
    if (!enabled) return
    const timer = setInterval(() => {
      void OpenCode.telegramStatus().then(setStatus).catch(() => {})
    }, 4_000)
    return () => clearInterval(timer)
  }, [enabled])

  const apply = async (patch: TelegramSettingsPatch): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setStatus(await OpenCode.telegramSet(patch))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (): Promise<void> => {
    if (!status) return
    if (!status.enabled && !status.tokenSet) {
      setError('Add your bot token from @BotFather before enabling.')
      return
    }
    if (!status.enabled && !status.threadId) {
      setError('Choose which thread messages are delivered to before enabling.')
      return
    }
    await apply({ enabled: !status.enabled })
  }

  const saveToken = async (): Promise<void> => {
    if (!tokenInput.trim()) {
      setError('Paste the bot token @BotFather sent you.')
      return
    }
    await apply({ token: tokenInput.trim() })
    setTokenInput('')
  }

  const clearToken = (): void => {
    appStore.setState({
      confirm: {
        title: 'Forget this bot?',
        message: 'The saved token is deleted and polling stops. You will need to paste it again from @BotFather to use Telegram.',
        confirmLabel: 'Forget bot',
        destructive: true,
        action: () => void apply({ clearToken: true })
      }
    })
  }

  const saveChats = async (): Promise<void> => {
    const ids = chatsInput.split(',').map((part) => Number(part.trim())).filter((id) => Number.isInteger(id) && id !== 0)
    await apply({ allowedChats: ids })
  }

  if (!status) return <div className="command-empty">Loading…</div>

  return (
    <section className="settings-card settings-card-list" aria-label="Telegram messaging">
      <SettingsRow
        title="Telegram inbox"
        description="Messages you send your own bot are delivered into one of your threads — steered into a running task or queued next, exactly like typing here. Off by default."
      >
        <div className="row-inline">
          {status.running ? <StatusBadge tone="success">Running</StatusBadge> : null}
          {!status.enabled ? <StatusBadge>Off</StatusBadge> : null}
          <Button size="small" disabled={busy} onClick={() => void toggle()}>
            {status.enabled ? 'Disable' : 'Enable'}
          </Button>
        </div>
      </SettingsRow>
      {error ? <div className="automation-error">{error}</div> : null}
      {status.error ? <div className="automation-error">{status.error}</div> : null}

      <SettingsRow
        title="Bot token"
        description={status.tokenSet
          ? `Saved${status.username ? ` as @${status.username}` : ''}. It is encrypted with your system keychain and never leaves this machine.`
          : 'Create a bot with @BotFather in Telegram, then paste its token here.'}
      >
        <div className="row-inline">
          {status.tokenSet ? (
            <>
              <StatusBadge tone="success">Token saved</StatusBadge>
              <Button size="small" variant="ghost" disabled={busy} onClick={clearToken}>Remove</Button>
            </>
          ) : (
            <>
              <input
                className="settings-input mobile-webhook"
                aria-label="Telegram bot token"
                type="password"
                placeholder="123456789:AA…"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
              />
              <Button size="small" disabled={busy} onClick={() => void saveToken()}>Save</Button>
            </>
          )}
        </div>
      </SettingsRow>

      <SettingsRow
        title="Deliver into thread"
        description="Where incoming messages go. While its agent runs they steer the run; otherwise they are sent as the next message."
      >
        <select
          className="ui-select settings-select"
          aria-label="Telegram delivery thread"
          value={status.threadId}
          disabled={busy}
          onChange={(e) => void apply({ threadId: e.target.value })}
        >
          <option value="">Choose a thread…</option>
          {sessions.map((session: SessionInfo) => (
            <option key={session.id} value={session.id}>{session.title || session.id}</option>
          ))}
        </select>
      </SettingsRow>

      <SettingsRow
        title="Allowed chats"
        description={
          status.pairedChatId !== undefined
            ? `Chat ${status.pairedChatId} paired itself by writing first. Add more ids to widen access; leave empty to keep pairing newcomers.`
            : 'Empty: the first chat that writes your bot is paired automatically. Comma-separated chat ids restrict who can reach BOSS.'
        }
      >
        <div className="row-inline">
          <input
            className="settings-input mobile-webhook"
            aria-label="Allowed Telegram chat ids"
            placeholder="e.g. 123456789"
            value={chatsInput}
            onChange={(e) => setChatsInput(e.target.value)}
          />
          <Button size="small" disabled={busy} onClick={() => void saveChats()}>Save</Button>
        </div>
      </SettingsRow>

      {status.enabled ? (
        <SettingsRow
          title="Activity"
          description={[
            status.username ? `Bot @${status.username}` : '',
            status.pairedChatId !== undefined ? `paired chat ${status.pairedChatId}` : '',
            status.lastMessageAt ? `last message ${timeAgo(status.lastMessageAt)}` : 'no messages yet'
          ].filter(Boolean).join(' · ')}
        />
      ) : null}
    </section>
  )
}
