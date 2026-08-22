/**
 * Reading a message's parts, matching how the desktop reads them.
 *
 * The classification mirrors src/renderer/src/lib/part-runs.ts so a thread
 * does not describe itself one way on the desktop and another on the phone.
 * Kept as plain functions, with no React, so it is testable on its own.
 */

export interface Part {
  type?: string
  text?: string
  state?: {
    status?: string
    input?: Record<string, unknown>
    output?: unknown
    title?: string
  }
  tool?: string
}

export interface Message {
  id?: string
  info?: { role?: string }
  parts?: Part[]
}

export type ToolKind = 'command' | 'page' | 'read' | 'edit' | 'other'

/** Whether a tool's input describes writing to a file rather than reading one. */
function writesToFile(input: Record<string, unknown>): boolean {
  return typeof input.content === 'string'
    || typeof input.new_string === 'string'
    || typeof input.newString === 'string'
    || typeof input.old_string === 'string'
    || typeof input.oldString === 'string'
    || Array.isArray(input.edits)
}

export function toolKind(part: Part): ToolKind {
  const input = part.state?.input
  if (input && writesToFile(input)) return 'edit'
  if (input && typeof input.command === 'string') return 'command'
  if (input && typeof input.url === 'string') return 'page'
  if (input && (typeof input.file_path === 'string' || typeof input.filePath === 'string')) {
    return writesToFile(input) ? 'edit' : 'read'
  }
  return 'other'
}

/** The most useful single line about a tool call: the command, url, or path. */
export function toolSummary(part: Part): string {
  const input = part.state?.input ?? {}
  const command = input.command
  if (typeof command === 'string') return command
  const url = input.url
  if (typeof url === 'string') return url
  const path = input.file_path ?? input.filePath
  if (typeof path === 'string') return String(path).split('/').slice(-2).join('/')
  return part.state?.title ?? part.tool ?? 'tool'
}

export function isRunning(status?: string): boolean {
  return status === 'running' || status === 'pending'
}

export function isError(status?: string): boolean {
  return status === 'error'
}

export function textOf(message: Message): string {
  return (message.parts ?? [])
    .filter((p) => p.type === 'text' && p.text)
    .map((p) => p.text)
    .join('\n')
}

/** Thinking, which the phone shows collapsed rather than inline. */
export function reasoningOf(message: Message): string {
  return (message.parts ?? [])
    .filter((p) => p.type === 'reasoning' && (p.text ?? '').trim())
    .map((p) => p.text)
    .join('\n')
}

export function toolsOf(message: Message): Part[] {
  return (message.parts ?? []).filter((p) => p.type === 'tool')
}

/** "3 commands · read 2 files", the way the desktop summarises a step. */
export function summarise(tools: Part[]): string {
  const counts = { command: 0, page: 0, read: 0, edit: 0, other: 0 }
  for (const tool of tools) counts[toolKind(tool)] += 1
  const parts: string[] = []
  if (counts.command) parts.push(`${counts.command} ${counts.command === 1 ? 'command' : 'commands'}`)
  if (counts.page) parts.push(`${counts.page} ${counts.page === 1 ? 'page' : 'pages'}`)
  if (counts.read) parts.push(`read ${counts.read} ${counts.read === 1 ? 'file' : 'files'}`)
  if (counts.edit) parts.push(`edited ${counts.edit} ${counts.edit === 1 ? 'file' : 'files'}`)
  if (!parts.length && counts.other) parts.push(`${counts.other} ${counts.other === 1 ? 'step' : 'steps'}`)
  return parts.join(' · ')
}

export interface Block {
  kind: 'text' | 'code'
  content: string
  /** Fence language, when the block declared one. */
  language?: string
}

/**
 * Split markdown into text and fenced code blocks.
 *
 * Only fences, deliberately: a phone transcript needs code to be readable and
 * selectable, and the rest of markdown adds far more surface than it repays.
 * An unterminated fence — which a streaming reply always has mid-write — is
 * treated as code to the end, so it renders as code while it arrives rather
 * than flickering.
 */
export function blocks(markdown: string): Block[] {
  const out: Block[] = []
  const lines = markdown.split('\n')
  let text: string[] = []
  let code: string[] | null = null
  let language: string | undefined

  const flushText = (): void => {
    if (text.join('').trim()) out.push({ kind: 'text', content: text.join('\n').replace(/^\n+|\n+$/g, '') })
    text = []
  }

  for (const line of lines) {
    const fence = /^\s*```(\S*)\s*$/.exec(line)
    if (fence) {
      if (code === null) {
        flushText()
        code = []
        language = fence[1] || undefined
      } else {
        out.push({ kind: 'code', content: code.join('\n'), language })
        code = null
        language = undefined
      }
      continue
    }
    if (code === null) text.push(line)
    else code.push(line)
  }

  if (code !== null) out.push({ kind: 'code', content: code.join('\n'), language })
  else flushText()
  return out
}

export type AttentionKind = 'permission' | 'question' | 'completed' | 'error' | 'interrupted'

export interface ThreadRow {
  threadId: string
  title?: string
  backendId?: string
  projectPath?: string
  worktreeBranch?: string
  running?: boolean
  updatedAt?: number
  attention?: { kind: AttentionKind; detail?: string }
  lastRun?: { status?: string; toolCalls?: number }
}

/** What a row needs you to know, in the order a glance should find it. */
export function attentionLabel(kind: AttentionKind): string {
  switch (kind) {
    case 'permission': return 'Needs approval'
    case 'question': return 'Asked a question'
    case 'error': return 'Failed'
    case 'interrupted': return 'Stopped'
    case 'completed': return 'Finished'
  }
}

/** Attention first, then running, then most recent. A phone list is read from
 *  the top and rarely scrolled, so what needs a decision has to be up there. */
export function sortThreads(threads: ThreadRow[]): ThreadRow[] {
  const rank = (t: ThreadRow): number => {
    if (t.attention?.kind === 'permission' || t.attention?.kind === 'question') return 0
    if (t.attention?.kind === 'error') return 1
    if (t.running) return 2
    if (t.attention) return 3
    return 4
  }
  return [...threads].sort((a, b) => rank(a) - rank(b) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
}

/** The project a thread works in, short enough for a phone row. */
export function projectLabel(thread: ThreadRow): string {
  const branch = thread.worktreeBranch
  const project = thread.projectPath?.split('/').filter(Boolean).pop()
  if (project && branch) return `${project} · ${branch}`
  return project ?? branch ?? ''
}

export interface ProjectGroup {
  /** Absolute path, and the key the UI addresses this group by. */
  path: string
  name: string
  threads: ThreadRow[]
  /** Threads in this project that need a person. Drives the badge. */
  waiting: number
  running: number
  updatedAt: number
}

/**
 * Group threads by the project they run in.
 *
 * The desktop's project list lives on a separate IPC channel the relay does not
 * carry, but every thread already reports its projectPath — so the phone can
 * reconstruct the same grouping without any new protocol. Threads with no
 * project (a scratch thread, or one whose checkout has gone) collect under a
 * single group rather than vanishing.
 */
export function groupByProject(threads: ThreadRow[]): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>()
  for (const thread of threads) {
    const path = thread.projectPath ?? ''
    let group = groups.get(path)
    if (!group) {
      group = {
        path,
        name: path ? path.split('/').filter(Boolean).pop() ?? path : 'No project',
        threads: [],
        waiting: 0,
        running: 0,
        updatedAt: 0
      }
      groups.set(path, group)
    }
    group.threads.push(thread)
    if (thread.attention?.kind === 'permission' || thread.attention?.kind === 'question') group.waiting += 1
    if (thread.running) group.running += 1
    group.updatedAt = Math.max(group.updatedAt, thread.updatedAt ?? 0)
  }
  for (const group of groups.values()) group.threads = sortThreads(group.threads)
  // Projects needing a person come first, then by recency — the same rule the
  // thread list uses, applied a level up.
  return [...groups.values()].sort((a, b) =>
    (b.waiting > 0 ? 1 : 0) - (a.waiting > 0 ? 1 : 0) || b.updatedAt - a.updatedAt
  )
}
