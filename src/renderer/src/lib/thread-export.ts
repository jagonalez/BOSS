import type { MessageWithParts, Part } from '@shared/opencode'

export interface ThreadExportMeta {
  title?: string
  backendLabel?: string
  projectPath?: string
  exportedAt?: number
}

/** One exchange: the user's message plus everything the assistant streamed
 *  back for it. Mirrors how the transcript groups turns for display. */
export interface ExportTurn {
  user?: MessageWithParts
  assistants: MessageWithParts[]
}

const TOOL_SUMMARY_CHARS = 120

function textOf(part: Part): string {
  return String(part.text ?? part.state?.text ?? '')
}

function toolName(part: Part): string {
  return String(part.tool ?? part.state?.tool ?? '').trim() || 'tool'
}

function oneLine(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/** The most useful thing a tool call did, for its one summary line. */
function toolSummary(part: Part): string {
  const titled = oneLine(part.state?.title)
  if (titled && titled !== toolName(part)) return titled
  const input = part.state?.input
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>
    const known = record.command ?? record.url ?? record.file_path ?? record.filePath ?? record.path
    const summarized = oneLine(known)
    if (summarized) return summarized
  }
  return ''
}

function truncate(value: string): string {
  return value.length > TOOL_SUMMARY_CHARS ? `${value.slice(0, TOOL_SUMMARY_CHARS)}…` : value
}

function imageLabel(part: Part): string {
  return oneLine(part.state?.name || part.state?.path) || 'image'
}

type Block =
  | { kind: 'text'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'note'; text: string }

class MessageWriter {
  private readonly blocks: Block[] = []
  /** Text already emitted from this message, so a backend that repeats the
   *  same prose under two part ids (streaming delta + reconciled history)
   *  exports it once, exactly as the transcript shows it. */
  private readonly seenText = new Set<string>()

  addPart(part: Part): void {
    switch (part.type) {
      case 'text': {
        const text = textOf(part)
        if (!text.trim()) return
        const key = text.replace(/\s+/g, ' ').trim()
        if (this.seenText.has(key)) return
        this.seenText.add(key)
        this.blocks.push({ kind: 'text', text })
        return
      }
      case 'tool': {
        const summary = truncate(toolSummary(part))
        const failed = part.state?.status === 'error'
          ? ' (failed)'
          : part.state?.status === 'interrupted' || part.state?.status === 'cancelled'
            ? ' (stopped)'
            : ''
        const item = `\`${toolName(part)}\`${summary ? `: ${summary}` : ''}${failed}`
        const last = this.blocks[this.blocks.length - 1]
        if (last?.kind === 'list') last.items.push(item)
        else this.blocks.push({ kind: 'list', items: [item] })
        return
      }
      case 'file': {
        if (part.state?.mime?.startsWith('image/')) {
          this.blocks.push({ kind: 'note', text: `_[Image: ${imageLabel(part)}]_` })
          return
        }
        const name = oneLine(part.state?.name || part.state?.path)
        if (name) this.blocks.push({ kind: 'note', text: `_[Attachment: ${name}]_` })
        return
      }
      case 'compaction':
        this.blocks.push({ kind: 'note', text: '_[Context compacted here]_' })
        return
      default:
        // Reasoning stays out of an export on purpose: it is working notes,
        // not what either party said. Step/agent markers carry no content.
        return
    }
  }

  get isEmpty(): boolean {
    return this.blocks.length === 0
  }

  render(): string {
    return this.blocks.map((block) => {
      if (block.kind === 'list') return block.items.map((item) => `- ${item}`).join('\n')
      return block.text
    }).join('\n\n')
  }
}

export function groupExportTurns(messages: MessageWithParts[]): ExportTurn[] {
  const turns: ExportTurn[] = []
  let current: ExportTurn = { assistants: [] }
  for (const message of messages) {
    if (message.info.role === 'user') {
      if (current.user || current.assistants.length > 0) turns.push(current)
      current = { user: message, assistants: [] }
    } else {
      current.assistants.push(message)
    }
  }
  if (current.user || current.assistants.length > 0) turns.push(current)
  return turns
}

function renderRole(role: 'User' | 'Assistant', messages: MessageWithParts[]): string | null {
  const writers = messages.map((message) => {
    const writer = new MessageWriter()
    for (const part of message.parts) writer.addPart(part)
    return writer
  }).filter((writer) => !writer.isEmpty)
  if (!writers.length) return null
  return [`### ${role}`, writers.map((writer) => writer.render()).join('\n\n')].join('\n\n')
}

/** Serialize a thread's transcript to clean Markdown.
 *
 *  User and assistant prose pass through untouched; reasoning is omitted;
 *  every tool call becomes one list line; images become placeholders naming
 *  the picture rather than embedding bytes. Turns follow the order recorded,
 *  so the file reads like the conversation went. */
export function serializeThreadMarkdown(messages: MessageWithParts[], meta: ThreadExportMeta = {}): string {
  const header: string[] = [`# ${meta.title?.trim() || 'Untitled thread'}`]
  const facts = [
    meta.backendLabel ? `Backend: ${meta.backendLabel}` : '',
    meta.projectPath ? `Project: ${meta.projectPath}` : '',
    meta.exportedAt !== undefined ? `Exported: ${new Date(meta.exportedAt).toISOString()}` : ''
  ].filter(Boolean)
  if (facts.length) header.push(`_${facts.join(' · ')}_`)

  const body = groupExportTurns(messages).flatMap((turn) => {
    const sections = [
      turn.user ? renderRole('User', [turn.user]) : null,
      renderRole('Assistant', turn.assistants)
    ].filter(Boolean)
    return sections.length ? [sections.join('\n\n')] : []
  })

  return [...header, ...body].join('\n\n') + '\n'
}

/** A file name for the save dialog, derived from the thread's title. */
export function exportFileName(title?: string): string {
  const slug = (title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return `${slug || 'thread'}.md`
}
