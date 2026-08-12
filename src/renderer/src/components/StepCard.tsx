import React, { useState } from 'react'
import type { MessageWithParts, Part } from '@shared/opencode'
import { unifiedDiff, type DiffLine } from '../lib/diff'
import { openReviewFile, selectSession } from '../lib/actions'
import { MessageText } from '../lib/text'
import { ChevronIcon, ReviewIcon } from './icons'

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  return `${m}m ${Math.round(s % 60)}s`
}

function messageDurationMs(message: MessageWithParts): number | null {
  const t = message.info.time
  if (t?.created && t?.completed) return t.completed - t.created
  const starts: number[] = []
  const ends: number[] = []
  for (const p of message.parts) {
    if (p.type === 'reasoning' && p.time?.start) starts.push(p.time.start)
    if (p.type === 'reasoning' && p.time?.end) ends.push(p.time.end)
  }
  if (starts.length && ends.length) return Math.max(...ends) - Math.min(...starts)
  return null
}

function toolKind(part: Part): 'command' | 'page' | 'edit' | 'other' {
  const input = part.state?.input as Record<string, unknown> | undefined
  if (input && typeof input.command === 'string') return 'command'
  if (input && typeof input.url === 'string') return 'page'
  if (input && (typeof input.file_path === 'string' || typeof input.filePath === 'string')) return 'edit'
  return 'other'
}

interface EditInput {
  file_path?: string
  filePath?: string
  old_string?: string
  new_string?: string
  oldString?: string
  newString?: string
  content?: string
}

function editInput(part: Part): EditInput | null {
  const input = part.state?.input as Partial<EditInput> | undefined
  if (!input?.file_path && !input?.filePath) return null
  return input as EditInput
}

function editPath(input: EditInput): string {
  return input.filePath || input.file_path || ''
}

function editStrings(input: EditInput): { oldS: string; newS: string } {
  if (typeof input.content === 'string') return { oldS: '', newS: input.content }
  const oldS = input.old_string ?? input.oldString ?? ''
  const newS = input.new_string ?? input.newString ?? ''
  return { oldS, newS }
}

function editStats(parts: Part[]): Map<string, { adds: number; dels: number }> {
  const map = new Map<string, { adds: number; dels: number }>()
  for (const p of parts) {
    const input = editInput(p)
    if (!input) continue
    const { oldS, newS } = editStrings(input)
    if (!newS && !oldS) continue
    const path = editPath(input)
    const diff = unifiedDiff(oldS, newS)
    const adds = diff.filter((l) => l.kind === 'add').length
    const dels = diff.filter((l) => l.kind === 'del').length
    const prev = map.get(path) ?? { adds: 0, dels: 0 }
    map.set(path, { adds: prev.adds + adds, dels: prev.dels + dels })
  }
  return map
}

function toolOutputText(part: Part): string {
  const s = part.state
  if (!s) return ''
  const out = s.output ?? (s.metadata as { output?: unknown } | undefined)?.output
  if (typeof out === 'string') return out
  if (out !== undefined && out !== null) {
    try {
      return JSON.stringify(out, null, 2)
    } catch {
      return String(out)
    }
  }
  return s.error ?? ''
}

function isRunning(status?: string): boolean {
  return status === 'running' || status === 'pending'
}

function isError(status?: string): boolean {
  return status === 'error' || status === 'interrupted' || status === 'cancelled'
}

function ReasoningNote({ text }: { text: string }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const long = text.length > 320 || text.split('\n').length > 6
  return (
    <div
      className={`step-reasoning${long ? ' expandable' : ''}${long && !expanded ? ' clamped' : ''}`}
      onClick={long ? () => setExpanded((value) => !value) : undefined}
      title={long ? (expanded ? 'Collapse' : 'Show full reasoning') : undefined}
    >
      <MessageText text={text} />
    </div>
  )
}

function StatusDot({ status }: { status?: string }): React.JSX.Element | null {
  if (isRunning(status)) return <span className="spinner-sm" />
  if (isError(status)) return <span className="step-status-error">!</span>
  return null
}

function MiniDiff({ lines }: { lines: DiffLine[] }): React.JSX.Element {
  return (
    <div className="mini-diff">
      {lines.map((line, i) => (
        <div key={i} className={`diff-line ${line.kind}`}>
          <span className="ln">{line.oldNo ?? ''}</span>
          <span className="ln">{line.newNo ?? ''}</span>
          <span>{line.text || ' '}</span>
        </div>
      ))}
    </div>
  )
}

function ToolDetail({ part }: { part: Part }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const input = editInput(part)
  const isEdit = input !== null
  const output = toolOutputText(part)
  const title = isEdit ? editPath(input) : part.state?.title || part.state?.tool || 'tool'
  const hasBody = Boolean(output && !isEdit) || isEdit

  const meta = (part.state?.metadata ?? {}) as { sessionId?: string; parentSessionId?: string }
  const subSessionId = part.state?.tool === 'task' ? meta.sessionId : undefined
  const isTask = part.state?.tool === 'task'

  let diff: DiffLine[] | null = null
  if (isEdit) {
    const { oldS, newS } = editStrings(input)
    if (newS || oldS) diff = unifiedDiff(oldS, newS)
  }

  return (
    <div className="tool-detail">
      <button className="tool-detail-head" onClick={() => setOpen((o) => !o)}>
        <StatusDot status={part.state?.status} />
        <span className="tool-detail-title" title={title}>
          {title}
        </span>
        {isEdit ? (
          <span
            className="tool-detail-review"
            title="Open diff in Review"
            onClick={(e) => {
              e.stopPropagation()
              void openReviewFile(editPath(input))
            }}
          >
            <ReviewIcon size={13} />
          </span>
        ) : null}
        {isTask && subSessionId ? (
          <span
            className="tool-detail-open"
            title="Open subagent session"
            onClick={(e) => {
              e.stopPropagation()
              void selectSession(subSessionId)
            }}
          >
            <span className="tool-detail-open-arrow">→</span>
          </span>
        ) : null}
        {hasBody ? (
          <span className="tool-detail-chevron" style={{ transform: open ? 'rotate(90deg)' : undefined }}>
            <ChevronIcon size={12} />
          </span>
        ) : null}
      </button>
      {open && (
        <>
          {diff ? <MiniDiff lines={diff} /> : null}
          {output && !isEdit ? <pre className="tool-detail-output">{output}</pre> : null}
        </>
      )}
    </div>
  )
}

export function StepCard({ message }: { message: MessageWithParts }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const tools = message.parts.filter((p) => p.type === 'tool')
  const hasReasoning = message.parts.some((p) => p.type === 'reasoning' && (p.text ?? '').trim())
  const files = editStats(message.parts)
  const duration = messageDurationMs(message)

  if (tools.length === 0 && !hasReasoning && files.size === 0) return null

  const running = tools.some((p) => isRunning(p.state?.status))
  const failed = tools.some((p) => isError(p.state?.status))
  const commands = tools.filter((p) => toolKind(p) === 'command').length
  const pages = tools.filter((p) => toolKind(p) === 'page').length

  const summary: string[] = []
  if (commands) summary.push(`${commands} ${commands === 1 ? 'command' : 'commands'}`)
  if (pages) summary.push(`${pages} ${pages === 1 ? 'page' : 'pages'} fetched`)
  if (files.size) summary.push(`edited ${files.size} ${files.size === 1 ? 'file' : 'files'}`)
  if (summary.length === 0 && tools.length) summary.push(`${tools.length} steps`)

  return (
    <div className={`step-card ${running ? 'running' : ''} ${failed ? 'failed' : ''}`}>
      <button className="step-card-head" onClick={() => setOpen((o) => !o)}>
        <StatusDot status={running ? 'running' : failed ? 'error' : undefined} />
        <span className="step-summary">{summary.join(' · ') || 'worked'}</span>
        <span className="step-duration">{duration !== null ? formatDuration(duration) : ''}</span>
        <span className="step-chevron" style={{ transform: open ? 'rotate(90deg)' : undefined }}>
          <ChevronIcon size={13} />
        </span>
      </button>
      {open && (
        <div className="step-details">
          {/* Chronological order: reasoning stays next to the tool calls it explains.
              Keys include the index because Claude emits tool_use and tool_result
              as separate parts sharing one id. */}
          {message.parts.map((part, index) => {
            if (part.type === 'reasoning' && (part.text ?? '').trim()) {
              return <ReasoningNote key={`${part.id}-${index}`} text={part.text ?? ''} />
            }
            if (part.type === 'tool') return <ToolDetail key={`${part.id}-${index}`} part={part} />
            return null
          })}
          {files.size > 0 && (
            <div className="step-files">
              <div className="step-files-label">Edited files — click to review</div>
              {[...files.entries()].map(([path, stats]) => (
                <div key={path} className="step-file" onClick={() => void openReviewFile(path)}>
                  <span className="step-file-path">{path}</span>
                  <span className="step-file-stats">
                    <span className="add">+{stats.adds}</span>
                    <span className="del">−{stats.dels}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
