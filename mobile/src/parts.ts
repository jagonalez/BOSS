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
    /** Where some backends put a reasoning part's text. */
    text?: string
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

/** One stretch of a message: something said, something thought, or work done.
 *
 *  A message is not a turn. Codex reports an entire session as one assistant
 *  message — hundreds of parts, alternating between saying something, thinking,
 *  and calling tools — where Claude sends one message per reply. Joining every
 *  text part into a single block, which is what this used to do, turned those
 *  into one unreadable wall with all the tool calls summarised at the end, and
 *  the conversation inside them was impossible to follow.
 *
 *  So a message renders as the sequence it actually was. Neighbouring parts of
 *  the same kind join up — consecutive tool calls are one collapsible group,
 *  consecutive text is one paragraph — and the order is preserved. */
export interface Segment {
  kind: 'text' | 'reasoning' | 'tools'
  /** For text and reasoning. */
  text?: string
  /** For tools. */
  parts?: Part[]
}

export function segmentsOf(message: Message): Segment[] {
  const out: Segment[] = []
  for (const part of message.parts ?? []) {
    const kind = part.type === 'text' ? 'text' as const
      : part.type === 'reasoning' ? 'reasoning' as const
      : part.type === 'tool' ? 'tools' as const
      : undefined
    if (!kind) continue

    if (kind === 'tools') {
      const last = out[out.length - 1]
      if (last?.kind === 'tools') last.parts!.push(part)
      else out.push({ kind, parts: [part] })
      continue
    }

    const text = (part.text ?? part.state?.text ?? '').trim()
    if (!text) continue
    const last = out[out.length - 1]
    if (last?.kind === kind) last.text = `${last.text}\n\n${text}`
    else out.push({ kind, text })
  }
  return out
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
  kind: 'text' | 'code' | 'heading' | 'bullet' | 'number' | 'quote' | 'rule'
  content: string
  /** Fence language, when the block declared one. */
  language?: string
  /** Heading depth, 1-6. Only on `heading`. */
  level?: number
  /** The marker a numbered item was written with, so 3. stays 3. */
  marker?: string
  /** Nesting depth of a list item, counted in two-space steps. */
  indent?: number
}

/** An inline run within one line: plain text, or a styled span. */
export interface Span {
  kind: 'plain' | 'bold' | 'italic' | 'code' | 'link' | 'strike'
  text: string
  /** Destination, on `link` only. */
  href?: string
  /** Runs inside this one, when it holds more markup. Absent on `code`, whose
   *  content is literal by definition. Agents write **`thing`** constantly. */
  children?: Span[]
}

const INLINE = [
  // Code first: backticks win over everything they contain, the way markdown
  // means them to. `**not bold**` inside a fence is literal asterisks.
  { kind: 'code' as const, re: /`([^`\n]+)`/ },
  { kind: 'link' as const, re: /\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/ },
  { kind: 'bold' as const, re: /\*\*([^*\n]+)\*\*/ },
  { kind: 'bold' as const, re: /__([^_\n]+)__/ },
  { kind: 'strike' as const, re: /~~([^~\n]+)~~/ },
  { kind: 'italic' as const, re: /(?<![*\w])\*([^*\n]+)\*(?!\*)/ },
  { kind: 'italic' as const, re: /(?<![_\w])_([^_\n]+)_(?![_\w])/ }
]

/**
 * Split one line into styled runs.
 *
 * Leftmost match wins, then the list order above breaks ties, which is what
 * makes `**a**` inside backticks stay literal. Anything unmatched stays plain,
 * so a stray asterisk renders as an asterisk instead of eating the rest of the
 * line — half-written emphasis arrives constantly in a streaming reply.
 *
 * A match's own text is parsed again, so **`thing`** is bold code rather than
 * bold text with the backticks showing. Code is the exception: its content is
 * literal, which is the whole point of it.
 */
export function spans(line: string): Span[] {
  const out: Span[] = []
  let rest = line

  while (rest) {
    let best: { index: number; length: number; span: Span } | undefined
    for (const { kind, re } of INLINE) {
      const m = re.exec(rest)
      if (!m) continue
      if (best && m.index >= best.index) continue
      best = {
        index: m.index,
        length: m[0].length,
        span: kind === 'link'
          ? { kind, text: m[1] || m[2], href: m[2] }
          : { kind, text: m[1] }
      }
    }
    if (!best) break
    if (best.index) out.push({ kind: 'plain', text: rest.slice(0, best.index) })
    if (best.span.kind !== 'code') {
      const inner = spans(best.span.text)
      // Only carry children when they say something the text does not: a lone
      // plain run is the text itself, and nesting it buys an extra <Text>.
      if (inner.length > 1 || inner[0]?.kind !== 'plain') best.span.children = inner
    }
    out.push(best.span)
    rest = rest.slice(best.index + best.length)
  }

  if (rest) out.push({ kind: 'plain', text: rest })
  return out.length ? out : [{ kind: 'plain', text: line }]
}

/**
 * Split markdown into blocks a phone can lay out.
 *
 * Fences come first and swallow everything until they close — an unterminated
 * one, which a streaming reply always has mid-write, is treated as code to the
 * end so it renders as code while it arrives rather than flickering.
 *
 * Outside a fence, a line that opens with a marker becomes its own block, and
 * everything else accumulates into a text paragraph. Inline styling is left to
 * spans() at render time, because a paragraph's runs depend on nothing but its
 * own text.
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
    if (code !== null) {
      code.push(line)
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flushText()
      out.push({ kind: 'heading', content: heading[2].trim(), level: heading[1].length })
      continue
    }

    // Three or more -, * or _ alone on a line. Checked before the bullet rule,
    // which would otherwise read `---` as a bullet holding two dashes.
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      flushText()
      out.push({ kind: 'rule', content: '' })
      continue
    }

    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line)
    if (bullet) {
      flushText()
      out.push({
        kind: 'bullet',
        content: bullet[2].trim(),
        indent: Math.floor(bullet[1].replace(/\t/g, '  ').length / 2)
      })
      continue
    }

    const numbered = /^(\s*)(\d{1,9})[.)]\s+(.*)$/.exec(line)
    if (numbered) {
      flushText()
      out.push({
        kind: 'number',
        content: numbered[3].trim(),
        marker: numbered[2],
        indent: Math.floor(numbered[1].replace(/\t/g, '  ').length / 2)
      })
      continue
    }

    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (quote) {
      flushText()
      out.push({ kind: 'quote', content: quote[1].trim() })
      continue
    }

    text.push(line)
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
  /** Hidden on the desktop, so hidden here. Before this was reported the phone
   *  listed every thread ever created and disagreed with the desktop's count. */
  archived?: boolean
  /** Set on a delegated worker. Shown under its parent rather than as a peer. */
  parentID?: string
  /** How much this thread's agent may do without asking. */
  mode?: string
  /** What the thread last ran on. Changing only the thinking level still means
   *  sending a whole model, because providerID and modelID are required. */
  model?: { providerID: string; modelID: string; variant?: string }
}

/**
 * What the thread list should show: not archived, and not a delegated worker.
 *
 * The desktop hides both, and until it reported them the phone could not: 58
 * threads on the phone against 26 on the desktop, with no way to tell which
 * were which.
 */
export function visibleThreads(threads: ThreadRow[]): ThreadRow[] {
  return threads.filter((t) => !t.archived && !t.parentID)
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
/**
 * Most recent first, except for threads blocked on a person.
 *
 * The five-way ranking this replaced sorted by a status the row then coloured,
 * which meant the list order kept changing for reasons that were not obvious
 * and a thread you had just touched could be anywhere. Only a thread that
 * cannot continue without you earns a place out of order.
 */
export function sortThreads(threads: ThreadRow[]): ThreadRow[] {
  const blocked = (t: ThreadRow): number =>
    t.attention?.kind === 'permission' || t.attention?.kind === 'question' ? 0 : 1
  return [...threads].sort((a, b) => blocked(a) - blocked(b) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
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
