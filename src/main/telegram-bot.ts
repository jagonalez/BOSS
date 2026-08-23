import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'

import type { BackendRequest, QueuedFollowUp } from '../shared/backend'
import {
  formatTelegramFollowUp,
  parseTelegramUpdate,
  routeTelegramMessage,
  type TelegramMessage,
  type TelegramSettingsPatch,
  type TelegramStatus,
  type TelegramUpdateInput
} from '../shared/telegram'

/**
 * Inbound messaging over the Telegram Bot API, entirely opt-in. One long-poll
 * loop reads updates for the user's own bot; accepted texts are delivered into
 * the configured thread through the same follow-up queue the composer uses, so
 * busy threads are steered and idle ones receive the message immediately.
 * The bot token never touches disk unencrypted — it is sealed with Electron
 * safeStorage, the same way Lab API keys are stored.
 */

interface TelegramHost {
  handle(request: BackendRequest): Promise<unknown>
  isThreadBusy(threadId: string): boolean
}

interface StoredConfig {
  version: 1
  enabled: boolean
  threadId: string
  allowedChatIds: number[]
  pairedChatId?: number
}

const POLL_TIMEOUT_SECONDS = 30
/** Slightly above the long-poll window, so a healthy poll never times out client-side. */
const REQUEST_TIMEOUT_MS = (POLL_TIMEOUT_SECONDS + 15) * 1_000
const MAX_BACKOFF_MS = 30_000
const TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]{30,}$/

const nodeRequire = createRequire(import.meta.url)

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveDelay) => {
    const timer = setTimeout(finish, ms)
    function finish(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolveDelay()
    }
    signal?.addEventListener('abort', finish)
  })
}

export class TelegramBot {
  private config: StoredConfig
  private running = false
  private loopPromise?: Promise<void>
  private inflight?: AbortController
  private username?: string
  private error?: string
  private lastMessageAt?: number
  /** Telegram deletes nothing; we remember how far we read across restarts. */
  private offset = 0
  private onChange?: () => void

  constructor(
    private readonly configFile: string,
    private readonly tokenFile: string,
    private readonly host: TelegramHost
  ) {
    this.config = this.load()
  }

  setOnChange(callback: () => void): void {
    this.onChange = callback
  }

  private load(): StoredConfig {
    try {
      const parsed = JSON.parse(readFileSync(this.configFile, 'utf8')) as Partial<StoredConfig>
      if (parsed.version === 1 && typeof parsed.enabled === 'boolean') {
        return {
          version: 1,
          enabled: parsed.enabled,
          threadId: typeof parsed.threadId === 'string' ? parsed.threadId : '',
          allowedChatIds: Array.isArray(parsed.allowedChatIds)
            ? [...new Set(parsed.allowedChatIds.filter((id): id is number => typeof id === 'number' && Number.isInteger(id)))]
            : [],
          ...(typeof parsed.pairedChatId === 'number' ? { pairedChatId: parsed.pairedChatId } : {})
        }
      }
    } catch {
      /* First launch starts off; inbound messaging is strictly opt-in. */
    }
    return { version: 1, enabled: false, threadId: '', allowedChatIds: [] }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.configFile), { recursive: true })
      writeFileSync(this.configFile, JSON.stringify(this.config, null, 2), { mode: 0o600 })
    } catch {
      /* Settings stay usable in memory even if persistence fails. */
    }
  }

  private readToken(): string {
    try {
      const { safeStorage } = nodeRequire('electron') as typeof import('electron')
      if (!safeStorage.isEncryptionAvailable()) return ''
      return safeStorage.decryptString(readFileSync(this.tokenFile)).trim()
    } catch {
      return ''
    }
  }

  private writeToken(token: string): void {
    if (!token) {
      try { unlinkSync(this.tokenFile) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      return
    }
    const { safeStorage } = nodeRequire('electron') as typeof import('electron')
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable on this system.')
    mkdirSync(dirname(this.tokenFile), { recursive: true })
    writeFileSync(this.tokenFile, safeStorage.encryptString(token), { mode: 0o600 })
    chmodSync(this.tokenFile, 0o600)
  }

  status(): TelegramStatus {
    return {
      enabled: this.config.enabled,
      running: this.running,
      ...(this.error ? { error: this.error } : {}),
      ...(this.username ? { username: this.username } : {}),
      threadId: this.config.threadId,
      allowedChatIds: [...this.config.allowedChatIds],
      ...(this.config.pairedChatId !== undefined ? { pairedChatId: this.config.pairedChatId } : {}),
      tokenSet: Boolean(this.readToken()),
      ...(this.lastMessageAt ? { lastMessageAt: this.lastMessageAt } : {})
    }
  }

  async handle(request: BackendRequest): Promise<unknown> {
    switch (request.type) {
      case 'telegram.status':
        return this.status()
      case 'telegram.set':
        return this.applyPatch(request.patch)
      default:
        throw new Error(`Unsupported Telegram request: ${request.type}`)
    }
  }

  private async applyPatch(patch: TelegramSettingsPatch): Promise<TelegramStatus> {
    if (patch.clearToken && patch.token !== undefined) throw new Error('Set a new token or clear the saved one, not both.')
    if (patch.threadId !== undefined) this.config.threadId = patch.threadId.trim()
    if (patch.allowedChats !== undefined) {
      this.config.allowedChatIds = [...new Set(patch.allowedChats.filter((id) => Number.isInteger(id) && id !== 0))]
    }
    if (patch.token !== undefined) {
      const token = patch.token.trim()
      if (!TOKEN_PATTERN.test(token)) throw new Error('That does not look like a bot token. Paste the one @BotFather sent you.')
      this.writeToken(token)
      this.username = undefined
    }
    if (patch.clearToken) {
      this.writeToken('')
      this.username = undefined
    }
    if (patch.enabled !== undefined) this.config.enabled = patch.enabled
    this.save()
    await this.restart()
    return this.status()
  }

  async start(): Promise<void> {
    if (this.running) return
    if (!this.config.enabled || !this.readToken()) return
    this.running = true
    this.loopPromise = this.loop()
  }

  async stop(): Promise<void> {
    this.running = false
    this.inflight?.abort()
    await this.loopPromise?.catch(() => {})
    this.loopPromise = undefined
    this.inflight = undefined
  }

  private async restart(): Promise<void> {
    await this.stop()
    await this.start()
  }

  private fail(message: string): void {
    if (this.error === message) return
    this.error = message
    this.onChange?.()
  }

  private recover(): void {
    if (this.error === undefined && this.username !== undefined) return
    this.error = undefined
    this.onChange?.()
  }

  private async loop(): Promise<void> {
    let failures = 0
    let verifiedToken = ''
    try {
      while (this.running) {
        const token = this.readToken()
        if (!token) break
        try {
          if (verifiedToken !== token) {
            this.username = await this.callApi<{ username?: string }>(token, 'getMe', {}, 10_000).then((me) => me.username)
            verifiedToken = token
            this.recover()
          }
          const updates = await this.callApi<TelegramUpdateInput[]>(token, 'getUpdates', {
            timeout: POLL_TIMEOUT_SECONDS,
            offset: this.offset,
            allowed_updates: ['message']
          }, REQUEST_TIMEOUT_MS)
          failures = 0
          this.recover()
          for (const update of Array.isArray(updates) ? updates : []) {
            const parsed = parseTelegramUpdate(update)
            if (!parsed) continue
            this.offset = parsed.updateId + 1
            this.deliver(parsed)
          }
        } catch (error) {
          if (!this.running) break
          verifiedToken = ''
          failures += 1
          this.fail(error instanceof Error ? error.message : String(error))
          await delay(Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(failures, 5)), this.inflight?.signal)
        }
      }
    } finally {
      this.running = false
      this.onChange?.()
    }
  }

  private deliver(message: TelegramMessage): void {
    const route = routeTelegramMessage({
      enabled: this.config.enabled,
      threadId: this.config.threadId,
      allowedChatIds: this.config.allowedChatIds,
      ...(this.config.pairedChatId !== undefined ? { pairedChatId: this.config.pairedChatId } : {})
    }, message)
    if (route.decision !== 'queue') return
    if (route.pairedChatId !== undefined && route.pairedChatId !== this.config.pairedChatId) {
      this.config.pairedChatId = route.pairedChatId
      this.save()
      this.onChange?.()
    }
    const threadId = this.config.threadId
    this.lastMessageAt = Date.now()
    void (async () => {
      try {
        const text = formatTelegramFollowUp(message)
        if (this.host.isThreadBusy(threadId)) {
          const queued = await this.host.handle({ type: 'thread.followups.add', threadId, text })
          const latest = Array.isArray(queued) ? (queued as QueuedFollowUp[]).at(-1) : undefined
          if (latest) await this.host.handle({ type: 'thread.followups.steer', threadId, followUpId: latest.id })
        } else {
          // An idle target delivers right away: addFollowUp drains its own queue.
          await this.host.handle({ type: 'thread.followups.add', threadId, text })
        }
        this.onChange?.()
      } catch (error) {
        this.fail(`Delivering a Telegram message failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })()
  }

  private async callApi<T>(token: string, method: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const controller = new AbortController()
    this.inflight = controller
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: controller.signal
      })
      const payload = await response.json().catch(() => ({})) as { ok?: boolean; result?: T; description?: string }
      if (!response.ok || !payload.ok) throw new Error(payload.description || `Telegram returned ${response.status}.`)
      return payload.result as T
    } finally {
      clearTimeout(timer)
      if (this.inflight === controller) this.inflight = undefined
    }
  }
}
