import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import type { MessageWithParts, Part, SessionInfo, Todo } from '@shared/opencode'

/** A session record Lab persists to disk. The store owns message history and
 *  the working directory each thread runs in, so both survive a restart and a
 *  thread moved onto a worktree runs against the right checkout.
 *
 *  `parentID` and `status` extend it into a task registry: a sub-agent is just
 *  another session that points back at the one that spawned it, so a parent
 *  can list, supervise, and wait on its children. */
export type LabSessionStatus = 'idle' | 'running' | 'completed' | 'error' | 'aborted'

export interface LabSessionRecord {
  id: string
  title?: string
  directory?: string
  parentID?: string
  status?: LabSessionStatus
  /** Tool names the user has answered "always allow" for on this thread. A
   *  lifetime grant against one session only, so it cannot follow the thread
   *  around the project. */
  alwaysAllow?: string[]
  /** The task list the model maintains for this thread. */
  todos?: Todo[]
  createdAt: number
  updatedAt: number
  messages: MessageWithParts[]
}

interface LabStoreFile {
  version: 1
  sessions: Record<string, LabSessionRecord>
}

function sessionInfo(record: LabSessionRecord): SessionInfo {
  return {
    id: record.id,
    title: record.title,
    directory: record.directory,
    path: record.directory,
    time: { created: record.createdAt, updated: record.updatedAt }
  }
}

/** Bump a record's updated time so it sorts above equally-recent siblings.
 *  Renames and new messages within the same millisecond must still reorder. */
function touch(record: LabSessionRecord): void {
  record.updatedAt = Math.max(Date.now(), record.updatedAt + 1)
}

/** A plain JSON file store. Kept free of Electron imports so it can be tested
 *  directly with a temp file, and so Lab never needs an agent framework. */
export class LabSessionStore {
  private readonly file: string
  private store: LabStoreFile

  constructor(file: string) {
    this.file = file
    this.store = this.load()
  }

  private load(): LabStoreFile {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as LabStoreFile
      if (parsed.version === 1 && parsed.sessions) return parsed
    } catch {
      /* First launch. */
    }
    return { version: 1, sessions: {} }
  }

  private save(): void {
    try {
      writeFileSync(this.file, JSON.stringify(this.store, null, 2))
    } catch {
      /* Threads keep working in memory if persistence is unavailable. */
    }
  }

  create(title?: string, directory?: string): SessionInfo {
    const now = Date.now()
    const record: LabSessionRecord = {
      id: randomUUID(),
      title,
      directory,
      createdAt: now,
      updatedAt: now,
      messages: []
    }
    this.store.sessions[record.id] = record
    this.save()
    return sessionInfo(record)
  }

  /** Create a sub-agent: a session owned by `parentID` and tracked as a
   *  child so the parent can list and supervise it. */
  createParented(title: string | undefined, directory: string, parentID: string): SessionInfo {
    const created = this.create(title, directory)
    const record = this.store.sessions[created.id]
    record.parentID = parentID
    record.status = 'idle'
    touch(record)
    this.save()
    return created
  }

  setStatus(id: string, status: LabSessionStatus): void {
    const record = this.get(id)
    record.status = status
    touch(record)
    this.save()
  }

  /** Record an "always allow" grant for a tool, or take it back. */
  grantAlways(id: string, tool: string): void {
    const record = this.get(id)
    const granted = new Set(record.alwaysAllow ?? [])
    granted.add(tool)
    record.alwaysAllow = [...granted]
    touch(record)
    this.save()
  }

  takeAlways(id: string, tool: string): void {
    const record = this.get(id)
    if (!record.alwaysAllow?.includes(tool)) return
    record.alwaysAllow = record.alwaysAllow.filter((item) => item !== tool)
    touch(record)
    this.save()
  }

  /** Children still marked running after a crash or quit. Their process is
   *  gone, so the caller reconciles them to a terminal state on startup. */
  runningChildren(): LabSessionRecord[] {
    return Object.values(this.store.sessions).filter(
      (record) => record.parentID && record.status === 'running'
    )
  }

  todosOf(id: string): Todo[] {
    return this.get(id).todos ?? []
  }

  setTodos(id: string, todos: Todo[]): void {
    const record = this.get(id)
    record.todos = todos
    touch(record)
    this.save()
  }

  /** Replace the whole message list (compaction rewrites history). */
  setMessages(id: string, messages: MessageWithParts[]): void {
    const record = this.get(id)
    record.messages = messages
    touch(record)
    this.save()
  }

  /** The sessions this one spawned, oldest first. Sub-agents are unregistered
   *  with BOSS, so this is the only place a parent finds its team. */
  childrenOf(id: string): LabSessionRecord[] {
    return Object.values(this.store.sessions)
      .filter((record) => record.parentID === id)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  /** The last assistant text, which is what a finished sub-agent reports. */
  lastAssistantText(id: string): string {
    for (const message of [...this.get(id).messages].reverse()) {
      if (message.info.role !== 'assistant') continue
      const text = message.parts.filter((part) => part.type === 'text').map((part) => part.text ?? '').filter(Boolean).join('\n')
      if (text.trim()) return text
    }
    return ''
  }

  subAgentSummary(record: LabSessionRecord): { id: string; title: string; status: LabSessionStatus; updatedAt: number } {
    return {
      id: record.id,
      title: record.title ?? 'Untitled',
      status: record.status ?? 'idle',
      updatedAt: record.updatedAt
    }
  }

  list(): SessionInfo[] {
    return Object.values(this.store.sessions)
      .map((record) => sessionInfo(record))
      .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
  }

  get(id: string): LabSessionRecord {
    const record = this.store.sessions[id]
    if (!record) throw new Error(`Lab thread not found: ${id}`)
    return record
  }

  rename(id: string, title: string): SessionInfo {
    const record = this.get(id)
    record.title = title
    touch(record)
    this.save()
    return sessionInfo(record)
  }

  delete(id: string): void {
    if (!this.store.sessions[id]) return
    delete this.store.sessions[id]
    this.save()
  }

  setDirectory(id: string, directory: string): void {
    const record = this.store.sessions[id]
    if (!record || !directory || record.directory === directory) return
    record.directory = directory
    this.save()
  }

  messages(id: string, limit?: number): MessageWithParts[] {
    const messages = this.get(id).messages
    return limit ? messages.slice(-limit) : messages
  }

  /** Replace (or append) a message. Streaming text is reported by re-inserting
   *  the whole message with its growing text part, like the other backends. */
  upsertMessage(id: string, message: MessageWithParts): void {
    const record = this.get(id)
    const index = record.messages.findIndex((item) => item.info.id === message.info.id)
    if (index >= 0) record.messages[index] = message
    else record.messages.push(message)
    touch(record)
    this.save()
  }

  updatePart(id: string, messageId: string, part: Part): void {
    const record = this.get(id)
    const message = record.messages.find((item) => item.info.id === messageId)
    if (!message) return
    const index = message.parts.findIndex((item) => item.id === part.id)
    if (index >= 0) message.parts[index] = part
    else message.parts.push(part)
    touch(record)
    this.save()
  }
}
