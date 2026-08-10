import React, { useEffect, useRef, useState } from 'react'
import { useStore, appStore, type Attachment } from '../state/AppState'
import type { MessageWithParts, Part } from '@shared/opencode'
import { abortRun, newSession, openProjectFolder, pushHistory, sendPrompt, setModel } from '../lib/actions'
import { errorSummary, errorDetails } from '../lib/errors'
import { MessageText } from '../lib/text'
import { AttachmentIcon, ChevronIcon, FileIcon, FolderIcon, PlusIcon, SendIcon, StopIcon } from './icons'
import { StepCard } from './StepCard'
import { ModelPicker } from './ModelPicker'

function partText(part: Part): string {
  const value = part.text ?? part.state?.text ?? part.state?.content ?? part.state?.title ?? ''
  return String(value)
}

function toolOutput(part: Part): string {
  const output = part.state?.output
  if (output === undefined || output === null) return ''
  if (typeof output === 'string') return output
  try {
    return JSON.stringify(output, null, 2)
  } catch {
    return String(output)
  }
}

function statusBadge(status?: string): React.JSX.Element | null {
  if (!status) return null
  const cls =
    status === 'running' || status === 'pending'
      ? 'running'
      : status === 'error' || status === 'interrupted' || status === 'cancelled'
        ? 'error'
        : 'done'
  return <span className={`badge ${cls}`}>{status}</span>
}

function Thinking({ text }: { text: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="thinking">
      <button className="thinking-toggle" onClick={() => setOpen((o) => !o)}>
        <span className="icon" style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 0.12s ease' }}>
          <ChevronIcon size={12} />
        </span>
        <span className="thinking-label">{open ? 'Thinking' : 'Thinking…'}</span>
        {!open && text ? <span className="thinking-preview">{text.slice(0, 90)}</span> : null}
      </button>
      {open && <div className="reasoning">{text}</div>}
    </div>
  )
}

function PartView({ part }: { part: Part }): React.JSX.Element | null {
  switch (part.type) {
    case 'text':
      return <MessageText text={partText(part)} />
    case 'reasoning':
      return <Thinking text={partText(part)} />
    case 'tool': {
      const output = toolOutput(part)
      return (
        <div className="tool-call">
          <div className="tool-call-head">
            <span>{part.state?.title || part.state?.tool || 'tool'}</span>
            {statusBadge(part.state?.status)}
          </div>
          {output ? <div className="tool-call-body">{output}</div> : null}
        </div>
      )
    }
    case 'step':
    case 'agent':
      return (
        <div className="tool-call-head" style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          {partText(part) || part.state?.title || part.type}
        </div>
      )
    case 'file': {
      const path = part.state?.path
      const content = partText(part)
      return (
        <div className="tool-call">
          <div className="tool-call-head">
            <span>{path || 'file'}</span>
            {statusBadge(part.state?.status)}
          </div>
          {content ? <div className="tool-call-body">{content}</div> : null}
        </div>
      )
    }
    case 'snapshot':
      return null
    default:
      return null
  }
}

function MessageError({ error }: { error?: unknown }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (!error) return null
  return (
    <div className="msg-error">
      <span className="msg-error-icon">!</span>
      <div className="msg-error-main">
        <span className="msg-error-summary">{errorSummary(error)}</span>
        {open ? <pre className="msg-error-detail">{errorDetails(error)}</pre> : null}
      </div>
      <button className="msg-error-toggle" onClick={() => setOpen((o) => !o)}>
        <span className={`msg-error-toggle-chevron ${open ? 'open' : ''}`}>
          <ChevronIcon size={12} />
        </span>
        {open ? 'Hide' : 'Details'}
      </button>
    </div>
  )
}

function MessageView({ item }: { item: MessageWithParts }): React.JSX.Element {
  const isUser = item.info.role === 'user'
  return (
    <div className={`msg ${isUser ? 'user' : 'assistant'}`}>
      <div className="msg-role">
        <span>{isUser ? 'You' : 'opencode'}</span>
        {item.info.model?.id ? <span className="model">{item.info.model.id}</span> : null}
      </div>
      <MessageError error={item.info.error} />
      <div className="msg-body">
        {isUser ? (
          item.parts.map((part) => <PartView key={part.id} part={part} />)
        ) : (
          <>
            <StepCard message={item} />
            {item.parts
              .filter((p) => p.type === 'text')
              .map((part) => (
                <PartView key={part.id} part={part} />
              ))}
          </>
        )}
      </div>
    </div>
  )
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function Composer({ sessionId }: { sessionId?: string }): React.JSX.Element {
  const streaming = useStore(appStore, (s) => s.streaming)
  const hasSession = useStore(appStore, (s) => Boolean(sessionId ?? s.activeSessionId))
  const effectiveSession = useStore(appStore, (s) => sessionId ?? s.activeSessionId)
  const text = useStore(appStore, (s) => (effectiveSession ? s.drafts[effectiveSession] ?? '' : ''))
  const attachments = useStore(appStore, (s) => (effectiveSession ? s.attachments[effectiveSession] ?? [] : []))
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [histIdx, setHistIdx] = useState(-1)
  const [draftBackup, setDraftBackup] = useState('')
  const history = useStore(appStore, (s) => (effectiveSession ? s.history[effectiveSession] ?? [] : []))

  useEffect(() => {
    setHistIdx(-1)
    setDraftBackup('')
  }, [effectiveSession])

  const setText = (value: string): void => {
    if (!effectiveSession) return
    appStore.setState((s) => ({ drafts: { ...s.drafts, [effectiveSession]: value } }))
  }

  const setAttachments = (list: Attachment[]): void => {
    if (!effectiveSession) return
    appStore.setState((s) => ({ attachments: { ...s.attachments, [effectiveSession]: list } }))
  }

  const addFiles = async (files: File[]): Promise<void> => {
    if (!effectiveSession || files.length === 0) return
    const loaded: Attachment[] = []
    for (const f of files) {
      if (f.size > 25 * 1024 * 1024) continue
      try {
        const dataUrl = await readFileAsDataUrl(f)
        loaded.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, name: f.name, mime: f.type || 'application/octet-stream', dataUrl })
      } catch {
        /* ignore unreadable */
      }
    }
    if (loaded.length) setAttachments([...attachments, ...loaded])
  }

  const onPaste = (e: React.ClipboardEvent): void => {
    const items = e.clipboardData?.items
    if (!items) return
    const files = Array.from(items)
      .filter((it) => it.kind === 'file')
      .map((it) => it.getAsFile())
      .filter((f): f is File => Boolean(f))
    if (files.length) {
      e.preventDefault()
      void addFiles(files)
    }
  }

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    if (e.dataTransfer?.files?.length) void addFiles(Array.from(e.dataTransfer.files))
  }

  const submit = (): void => {
    if (!effectiveSession) return
    if (!text.trim() && attachments.length === 0) return
    if (text.trim()) pushHistory(effectiveSession, text)
    void sendPrompt(text, sessionId, attachments)
    setText('')
    setAttachments([])
    setHistIdx(-1)
    setDraftBackup('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }

  const stepHistory = (dir: 1 | -1): void => {
    if (history.length === 0) return
    if (dir === -1) {
      if (histIdx === -1) {
        setDraftBackup(text)
        setHistIdx(history.length - 1)
        setText(history[history.length - 1])
      } else if (histIdx > 0) {
        const idx = histIdx - 1
        setHistIdx(idx)
        setText(history[idx])
      }
    } else {
      if (histIdx === -1) return
      if (histIdx < history.length - 1) {
        const idx = histIdx + 1
        setHistIdx(idx)
        setText(history[idx])
      } else {
        setHistIdx(-1)
        setText(draftBackup)
      }
    }
    autoGrow()
  }

  const onModelChange = (to: string): void => {
    const state = appStore.getState()
    if (to === state.model) return
    const sid = sessionId ?? state.activeSessionId
    const hasMessages = sid ? (state.messages[sid]?.length ?? 0) > 0 : false
    if (hasMessages) {
      appStore.setState({ modelSwitch: { to } })
    } else {
      setModel(to)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
      return
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const el = textareaRef.current
      if (el && el.selectionStart === 0 && el.selectionStart === el.selectionEnd) {
        e.preventDefault()
        stepHistory(e.key === 'ArrowUp' ? -1 : 1)
      }
    }
  }

  const autoGrow = (): void => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }

  const canSend = text.trim().length > 0 || attachments.length > 0
  const lastError = useStore(appStore, (s) => s.lastError)

  return (
    <div className="composer-wrap">
      {lastError ? (
        <div className="chat-error">
          <span className="chat-error-icon">!</span>
          <span className="chat-error-text">{lastError}</span>
          <button className="chat-error-close" onClick={() => appStore.setState({ lastError: null })} title="Dismiss">
            ×
          </button>
        </div>
      ) : null}
      <div className="composer" onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
        <div className="composer-input">
          <textarea
            ref={textareaRef}
            placeholder={hasSession ? 'Ask opencode…' : 'Start a chat to ask opencode'}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              autoGrow()
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            rows={1}
          />
          {attachments.length > 0 && (
            <div className="composer-attachments">
              {attachments.map((a) => (
                <div key={a.id} className={`attachment ${a.mime.startsWith('image/') ? '' : 'file'}`}>
                  {a.mime.startsWith('image/') ? (
                    <img src={a.dataUrl} alt={a.name} />
                  ) : (
                    <div className="attachment-file">
                      <FileIcon size={16} />
                      <span className="attachment-file-name">{a.name}</span>
                    </div>
                  )}
                  <button
                    className="attachment-remove"
                    onClick={() => setAttachments(attachments.filter((x) => x.id !== a.id))}
                    title="Remove"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="composer-controls">
          <div className="row">
            <button className="composer-attach" onClick={() => fileInputRef.current?.click()} title="Attach file or image">
              <AttachmentIcon size={16} />
            </button>
            <ModelPicker onPick={onModelChange} />
          </div>
          {streaming ? (
            <button className="btn-send" onClick={() => void abortRun()} title="Stop">
              <StopIcon size={16} />
            </button>
          ) : (
            <button className="btn-send" disabled={!canSend || !hasSession} onClick={submit} title="Send">
              <SendIcon size={16} />
            </button>
          )}
        </div>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) void addFiles(Array.from(e.target.files))
          e.target.value = ''
        }}
      />
    </div>
  )
}

interface TurnGroup {
  user?: MessageWithParts
  assistants: MessageWithParts[]
}

function groupTurns(messages: MessageWithParts[]): TurnGroup[] {
  const groups: TurnGroup[] = []
  let current: TurnGroup = { assistants: [] }
  for (const m of messages) {
    if (m.info.role === 'user') {
      if (current.assistants.length > 0) groups.push(current)
      current = { user: m, assistants: [] }
    } else {
      current.assistants.push(m)
    }
  }
  if (current.user || current.assistants.length > 0) groups.push(current)
  return groups
}

function combineAssistants(messages: MessageWithParts[]): MessageWithParts {
  const parts = messages.flatMap((m) => m.parts)
  const created = Math.min(...messages.map((m) => m.info.time?.created).filter((t): t is number => typeof t === 'number'))
  const completed = Math.max(...messages.map((m) => m.info.time?.completed).filter((t): t is number => typeof t === 'number'))
  return {
    info: {
      ...messages[0].info,
      time: {
        created: Number.isFinite(created) ? created : undefined,
        completed: Number.isFinite(completed) ? completed : undefined
      }
    },
    parts
  }
}

function TurnView({ turn, modelChanged }: { turn: TurnGroup; modelChanged?: boolean }): React.JSX.Element {
  const model = turn.assistants[0]?.info.model?.id
  const texts = turn.assistants.flatMap((m) =>
    m.parts
      .filter((p) => p.type === 'text')
      .map((p) => ({ key: p.id, part: p }))
  )
  return (
    <>
      {turn.user ? <MessageView item={turn.user} /> : null}
      {turn.assistants.length > 0 ? (
        <div className="msg assistant">
          <MessageError error={turn.assistants[turn.assistants.length - 1].info.error} />
          <div className="msg-body">
            {modelChanged && model ? <span className="model-chip">{model}</span> : null}
            <StepCard message={combineAssistants(turn.assistants)} />
            {texts.map(({ key, part }) => (
              <PartView key={key} part={part} />
            ))}
          </div>
        </div>
      ) : null}
    </>
  )
}

export function ChatView({ sessionId }: { sessionId?: string }): React.JSX.Element {
  const activeSessionId = useStore(appStore, (s) => s.activeSessionId)
  const effectiveId = sessionId ?? activeSessionId
  const messages = useStore(appStore, (s) => (effectiveId ? s.messages[effectiveId] ?? [] : []))
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, effectiveId])

  if (!effectiveId) {
    return (
      <div className="chat">
        <div className="empty">
          <div className="hero-mark">R</div>
          <h2>Ralf</h2>
          <p>A Codex-style desktop client for opencode.</p>
          <div className="actions">
            <button className="action" onClick={() => void newSession()}>
              <span className="icon">
                <PlusIcon size={15} />
              </span>
              New chat
            </button>
            <button className="action" onClick={() => void openProjectFolder()}>
              <span className="icon">
                <FolderIcon size={15} />
              </span>
              Open folder
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="chat">
      <div className="messages" ref={scrollRef}>
        {(() => {
          let lastModel: string | undefined
          return groupTurns(messages).map((turn, i) => {
            const model = turn.assistants[0]?.info.model?.id
            const changed = Boolean(model) && model !== lastModel
            if (model) lastModel = model
            return <TurnView key={i} turn={turn} modelChanged={changed} />
          })
        })()}
      </div>
      <Composer sessionId={sessionId} />
    </div>
  )
}
