import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { BackendId } from '@shared/backend'
import type { MessageInfo, MessageWithParts, Part } from '@shared/opencode'

interface TranscriptSource {
  threadId: string
  backendId: BackendId
  nativeSessionId: string
}

interface StoredMessageRow {
  message_id: string
  data_json: string
  position: number
}

interface StoredPartRow {
  part_id?: string
  message_id: string
  data_json: string
}

interface PendingMessage {
  source: TranscriptSource
  info: MessageInfo
}

interface PendingPart {
  source: TranscriptSource
  part: Part
}

type RunStatus = 'running' | 'completed' | 'error' | 'interrupted'

const MAX_TOOL_OUTPUT_CHARS = 100_000

function boundedOutput(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_TOOL_OUTPUT_CHARS
      ? `${value.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n[output truncated by R.A.L.F.]`
      : value
  }
  if (value === undefined) return undefined
  try {
    const serialized = JSON.stringify(value)
    return serialized.length > MAX_TOOL_OUTPUT_CHARS
      ? `${serialized.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n[output truncated by R.A.L.F.]`
      : value
  } catch {
    return String(value)
  }
}

function normalizePart(part: Part): Part {
  return part.state && part.state.output !== undefined
    ? { ...part, state: { ...part.state, output: boundedOutput(part.state.output) } }
    : part
}

function mergeMessage(previous: MessageInfo | undefined, next: MessageInfo): MessageInfo {
  if (!previous) return next
  return {
    ...previous,
    ...next,
    model: { ...previous.model, ...next.model },
    time: { ...previous.time, ...next.time }
  }
}

function mergePart(previous: Part | undefined, next: Part): Part {
  if (!previous) return next
  return {
    ...previous,
    ...next,
    time: { ...previous.time, ...next.time },
    state: previous.state || next.state
      ? {
          ...previous.state,
          ...next.state,
          metadata: { ...previous.state?.metadata, ...next.state?.metadata }
        }
      : undefined
  }
}

function parseJson<T>(value: string): T | undefined {
  try {
    return JSON.parse(value) as T
  } catch {
    return undefined
  }
}

function narrativeKey(part: Part): string | undefined {
  if (part.type !== 'text' && part.type !== 'reasoning') return undefined
  const text = (part.text ?? part.state?.text ?? '').replace(/\s+/g, ' ').trim()
  return text ? `${part.type}\u0000${text}` : undefined
}

/**
 * Durable, backend-neutral projection of the events R.A.L.F. has observed.
 *
 * Backends remain responsible for their native sessions. This store owns the
 * transcript shown by R.A.L.F., so a lossy native history response can update
 * known content but can never erase richer tool/activity parts seen live.
 */
export class TranscriptStore {
  private readonly database: DatabaseSync
  private readonly pendingMessages = new Map<string, PendingMessage>()
  private readonly pendingParts = new Map<string, PendingPart>()
  private flushTimer?: NodeJS.Timeout
  private closed = false

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.database = new DatabaseSync(path)
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS transcript_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transcript_threads (
        thread_id TEXT PRIMARY KEY,
        backend_id TEXT NOT NULL,
        native_session_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transcript_messages (
        thread_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        role TEXT NOT NULL,
        position INTEGER NOT NULL,
        data_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (thread_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS transcript_messages_order
        ON transcript_messages(thread_id, position);
      CREATE TABLE IF NOT EXISTS transcript_parts (
        thread_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        part_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        data_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (thread_id, message_id, part_id)
      );
      CREATE INDEX IF NOT EXISTS transcript_parts_order
        ON transcript_parts(thread_id, message_id, position);
      CREATE TABLE IF NOT EXISTS transcript_runs (
        thread_id TEXT PRIMARY KEY,
        backend_id TEXT NOT NULL,
        native_session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER
      );
    `)
    this.recoverInterruptedRuns()
  }

  recordMessage(source: TranscriptSource, info: MessageInfo): void {
    const key = `${source.threadId}\u0000${info.id}`
    const pending = this.pendingMessages.get(key)
    this.pendingMessages.set(key, {
      source,
      info: mergeMessage(pending?.info, { ...info, sessionID: source.threadId })
    })
    this.scheduleFlush()
  }

  recordPart(source: TranscriptSource, part: Part): void {
    const normalized = normalizePart({ ...part, sessionID: source.threadId })
    const key = `${source.threadId}\u0000${part.messageID}\u0000${part.id}`
    const pending = this.pendingParts.get(key)
    this.pendingParts.set(key, {
      source,
      part: mergePart(pending?.part, normalized)
    })
    // Tool boundaries must survive an immediate renderer/main-process crash.
    // Text and reasoning deltas remain debounced to avoid one transaction per token.
    if (part.type === 'tool') this.flush()
    else this.scheduleFlush()
  }

  beginRun(source: TranscriptSource): void {
    this.flush()
    this.transaction(() => {
      this.upsertThread(source)
      this.database.prepare(`
        INSERT INTO transcript_runs(
          thread_id, backend_id, native_session_id, status, started_at, finished_at
        ) VALUES (?, ?, ?, 'running', ?, NULL)
        ON CONFLICT(thread_id) DO UPDATE SET
          backend_id = excluded.backend_id,
          native_session_id = excluded.native_session_id,
          status = 'running',
          started_at = excluded.started_at,
          finished_at = NULL
      `).run(source.threadId, source.backendId, source.nativeSessionId, Date.now())
    })
  }

  finishRun(source: TranscriptSource, status: Exclude<RunStatus, 'running'>): void {
    this.flush()
    this.transaction(() => {
      this.upsertThread(source)
      const result = this.database.prepare(`
        UPDATE transcript_runs
        SET status = ?, finished_at = ?
        WHERE thread_id = ? AND status = 'running'
      `).run(status, Date.now(), source.threadId)
      if (result.changes > 0) {
        this.markRunningParts(
          source.threadId,
          status === 'error' ? 'error' : 'interrupted',
          status === 'completed'
            ? 'The run finished before this step reported completion.'
            : 'The run stopped before this step completed.'
        )
      }
    })
  }

  reconcile(
    source: TranscriptSource,
    messages: MessageWithParts[],
    options: { pruneMissingMessages?: boolean } = {}
  ): void {
    this.flush()
    this.transaction(() => {
      if (options.pruneMissingMessages) {
        const ids = new Set(messages.map((message) => message.info.id))
        const existing = this.database.prepare(
          'SELECT message_id FROM transcript_messages WHERE thread_id = ?'
        ).all(source.threadId) as unknown as Array<{ message_id: string }>
        for (const row of existing) {
          if (ids.has(row.message_id)) continue
          this.database.prepare(
            'DELETE FROM transcript_parts WHERE thread_id = ? AND message_id = ?'
          ).run(source.threadId, row.message_id)
          this.database.prepare(
            'DELETE FROM transcript_messages WHERE thread_id = ? AND message_id = ?'
          ).run(source.threadId, row.message_id)
        }
      }
      messages.forEach((message, messageIndex) => {
        const info = { ...message.info, sessionID: source.threadId }
        this.upsertMessage(source, info, messageIndex * 1024)
        message.parts.forEach((part, partIndex) => {
          this.upsertPart(source, normalizePart({ ...part, sessionID: source.threadId }), partIndex * 1024)
        })
        this.removeSupersededNarrativeParts(
          source.threadId,
          message.info.id,
          new Set(message.parts.map((part) => part.id))
        )
      })
    })
  }

  messages(threadId: string, limit?: number): MessageWithParts[] {
    this.flush()
    const messageRows = this.database.prepare(`
      SELECT message_id, data_json, position
      FROM transcript_messages
      WHERE thread_id = ?
      ORDER BY position ASC, updated_at ASC
    `).all(threadId) as unknown as StoredMessageRow[]
    const selected = limit ? messageRows.slice(-limit) : messageRows
    if (!selected.length) return []

    const partRows = this.database.prepare(`
      SELECT message_id, part_id, data_json
      FROM transcript_parts
      WHERE thread_id = ?
      ORDER BY message_id ASC, position ASC, updated_at ASC
    `).all(threadId) as unknown as StoredPartRow[]
    const partsByMessage = new Map<string, Part[]>()
    const narrativeByMessage = new Map<string, Set<string>>()
    for (const row of partRows) {
      const part = parseJson<Part>(row.data_json)
      if (!part) continue
      const key = narrativeKey(part)
      if (key) {
        const seen = narrativeByMessage.get(row.message_id) ?? new Set<string>()
        if (seen.has(key)) continue
        seen.add(key)
        narrativeByMessage.set(row.message_id, seen)
      }
      const parts = partsByMessage.get(row.message_id) ?? []
      parts.push(part)
      partsByMessage.set(row.message_id, parts)
    }

    return selected.flatMap((row) => {
      const info = parseJson<MessageInfo>(row.data_json)
      return info ? [{ info, parts: partsByMessage.get(row.message_id) ?? [] }] : []
    })
  }

  hasMessages(threadId: string): boolean {
    this.flush()
    const row = this.database.prepare(
      'SELECT 1 AS present FROM transcript_messages WHERE thread_id = ? LIMIT 1'
    ).get(threadId) as { present?: number } | undefined
    return row?.present === 1
  }

  deleteThread(threadId: string): void {
    this.flush()
    this.transaction(() => {
      this.database.prepare('DELETE FROM transcript_parts WHERE thread_id = ?').run(threadId)
      this.database.prepare('DELETE FROM transcript_messages WHERE thread_id = ?').run(threadId)
      this.database.prepare('DELETE FROM transcript_runs WHERE thread_id = ?').run(threadId)
      this.database.prepare('DELETE FROM transcript_threads WHERE thread_id = ?').run(threadId)
    })
  }

  metadata(key: string): string | undefined {
    const row = this.database.prepare(
      'SELECT value FROM transcript_metadata WHERE key = ?'
    ).get(key) as { value?: string } | undefined
    return row?.value
  }

  setMetadata(key: string, value: string): void {
    this.database.prepare(`
      INSERT INTO transcript_metadata(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value)
  }

  close(): void {
    if (this.closed) return
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    this.flush()
    this.database.close()
    this.closed = true
  }

  flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    if (!this.pendingMessages.size && !this.pendingParts.size) return
    const messages = [...this.pendingMessages.values()]
    const parts = [...this.pendingParts.values()]
    this.pendingMessages.clear()
    this.pendingParts.clear()
    this.transaction(() => {
      for (const message of messages) this.upsertMessage(message.source, message.info)
      for (const part of parts) this.upsertPart(part.source, part.part)
    })
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      try {
        this.flush()
      } catch (error) {
        process.stderr.write(`[transcripts] ${error instanceof Error ? error.message : String(error)}\n`)
      }
    }, 100)
    this.flushTimer.unref()
  }

  private upsertThread(source: TranscriptSource): void {
    this.database.prepare(`
      INSERT INTO transcript_threads(thread_id, backend_id, native_session_id, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        backend_id = excluded.backend_id,
        native_session_id = excluded.native_session_id,
        updated_at = excluded.updated_at
    `).run(source.threadId, source.backendId, source.nativeSessionId, Date.now())
  }

  private recoverInterruptedRuns(): void {
    const active = this.database.prepare(`
      SELECT thread_id FROM transcript_runs WHERE status = 'running'
    `).all() as unknown as Array<{ thread_id: string }>
    if (!active.length) return
    this.transaction(() => {
      for (const run of active) {
        this.markRunningParts(
          run.thread_id,
          'interrupted',
          'R.A.L.F. stopped before this step completed.'
        )
      }
      this.database.prepare(`
        UPDATE transcript_runs
        SET status = 'interrupted', finished_at = ?
        WHERE status = 'running'
      `).run(Date.now())
    })
  }

  private markRunningParts(
    threadId: string,
    status: 'error' | 'interrupted',
    error: string
  ): void {
    const rows = this.database.prepare(`
      SELECT message_id, part_id, data_json
      FROM transcript_parts WHERE thread_id = ?
    `).all(threadId) as unknown as Array<{ message_id: string; part_id: string; data_json: string }>
    const update = this.database.prepare(`
      UPDATE transcript_parts SET data_json = ?, updated_at = ?
      WHERE thread_id = ? AND message_id = ? AND part_id = ?
    `)
    for (const row of rows) {
      const part = parseJson<Part>(row.data_json)
      if (!part || part.type !== 'tool' || (part.state?.status !== 'running' && part.state?.status !== 'pending')) continue
      const next: Part = {
        ...part,
        state: { ...part.state, status, error }
      }
      update.run(JSON.stringify(next), Date.now(), threadId, row.message_id, row.part_id)
    }
  }

  private removeSupersededNarrativeParts(
    threadId: string,
    messageId: string,
    authoritativePartIds: Set<string>
  ): void {
    const rows = this.database.prepare(`
      SELECT message_id, part_id, data_json
      FROM transcript_parts
      WHERE thread_id = ? AND message_id = ?
      ORDER BY position ASC, updated_at ASC
    `).all(threadId, messageId) as unknown as Array<Required<StoredPartRow>>
    const authoritativeKeys = new Set<string>()
    for (const row of rows) {
      if (!authoritativePartIds.has(row.part_id)) continue
      const part = parseJson<Part>(row.data_json)
      const key = part ? narrativeKey(part) : undefined
      if (key) authoritativeKeys.add(key)
    }
    if (!authoritativeKeys.size) return
    const remove = this.database.prepare(`
      DELETE FROM transcript_parts
      WHERE thread_id = ? AND message_id = ? AND part_id = ?
    `)
    for (const row of rows) {
      if (authoritativePartIds.has(row.part_id)) continue
      const part = parseJson<Part>(row.data_json)
      const key = part ? narrativeKey(part) : undefined
      if (key && authoritativeKeys.has(key)) remove.run(threadId, messageId, row.part_id)
    }
  }

  private upsertMessage(source: TranscriptSource, next: MessageInfo, preferredPosition?: number): void {
    this.upsertThread(source)
    const existing = this.database.prepare(`
      SELECT data_json, position FROM transcript_messages
      WHERE thread_id = ? AND message_id = ?
    `).get(source.threadId, next.id) as { data_json: string; position: number } | undefined
    const previous = existing ? parseJson<MessageInfo>(existing.data_json) : undefined
    const info = mergeMessage(previous, { ...next, sessionID: source.threadId })
    const position = preferredPosition ?? existing?.position ?? this.nextMessagePosition(source.threadId)
    this.database.prepare(`
      INSERT INTO transcript_messages(thread_id, message_id, role, position, data_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id, message_id) DO UPDATE SET
        role = excluded.role,
        position = excluded.position,
        data_json = excluded.data_json,
        updated_at = excluded.updated_at
    `).run(source.threadId, info.id, info.role, position, JSON.stringify(info), Date.now())
  }

  private upsertPart(source: TranscriptSource, next: Part, preferredPosition?: number): void {
    const existing = this.database.prepare(`
      SELECT data_json, position FROM transcript_parts
      WHERE thread_id = ? AND message_id = ? AND part_id = ?
    `).get(source.threadId, next.messageID, next.id) as { data_json: string; position: number } | undefined
    const previous = existing ? parseJson<Part>(existing.data_json) : undefined
    const part = mergePart(previous, { ...next, sessionID: source.threadId })
    if (!this.messageExists(source.threadId, part.messageID)) {
      this.upsertMessage(source, {
        id: part.messageID,
        sessionID: source.threadId,
        role: 'assistant',
        time: { created: part.time?.created ?? part.time?.start }
      })
    }
    const position = existing?.position ?? preferredPosition ?? this.nextPartPosition(source.threadId, part.messageID)
    this.database.prepare(`
      INSERT INTO transcript_parts(thread_id, message_id, part_id, position, data_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id, message_id, part_id) DO UPDATE SET
        position = excluded.position,
        data_json = excluded.data_json,
        updated_at = excluded.updated_at
    `).run(source.threadId, part.messageID, part.id, position, JSON.stringify(part), Date.now())
  }

  private messageExists(threadId: string, messageId: string): boolean {
    return Boolean(this.database.prepare(`
      SELECT 1 FROM transcript_messages WHERE thread_id = ? AND message_id = ? LIMIT 1
    `).get(threadId, messageId))
  }

  private nextMessagePosition(threadId: string): number {
    const row = this.database.prepare(`
      SELECT COALESCE(MAX(position), -1024) + 1024 AS position
      FROM transcript_messages WHERE thread_id = ?
    `).get(threadId) as { position: number }
    return row.position
  }

  private nextPartPosition(threadId: string, messageId: string): number {
    const row = this.database.prepare(`
      SELECT COALESCE(MAX(position), -1024) + 1024 AS position
      FROM transcript_parts WHERE thread_id = ? AND message_id = ?
    `).get(threadId, messageId) as { position: number }
    return row.position
  }

  private transaction(work: () => void): void {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      work()
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }
}
