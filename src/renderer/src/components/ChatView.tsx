import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore, appStore, type Attachment } from '../state/AppState'
import type { MessageWithParts, Part, Command } from '@shared/opencode'
import { abortRun, editMessage, forkFromMessage, newSession, openProjectFolder, pushHistory, revertMessage, runCommand, sendPrompt, setAgent, setMode, setModel, unrevertSession } from '../lib/actions'
import { errorSummary, errorDetails } from '../lib/errors'
import { OpenCode } from '../lib/opencode'
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

function msgText(m: MessageWithParts): string {
  return m.parts
    .filter((p) => p.type === 'text')
    .map((p) => partText(p))
    .filter(Boolean)
    .join('\n')
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

function MessageView({
  item,
  onCtx
}: {
  item: MessageWithParts
  onCtx?: (e: React.MouseEvent, item: MessageWithParts) => void
}): React.JSX.Element {
  const isUser = item.info.role === 'user'
  return (
    <div className={`msg ${isUser ? 'user' : 'assistant'}`} onContextMenu={onCtx ? (e) => onCtx(e, item) : undefined}>
      {onCtx ? (
        <button className="msg-more" onClick={(e) => onCtx(e, item)} title="Message options">
          ⋯
        </button>
      ) : null}
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

function ModePicker(): React.JSX.Element {
  const mode = useStore(appStore, (s) => s.mode)
  const agent = useStore(appStore, (s) => s.agent)
  const agents = useStore(appStore, (s) => s.agents)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const INTERNAL_AGENTS = new Set(['build', 'plan', 'compaction', 'title', 'summary'])
  const otherAgents = agents.filter((a) => a.id && !INTERNAL_AGENTS.has(a.id))
  const label =
    mode === 'auto' ? 'Auto' : mode === 'plan' ? 'Plan' : agent && agent !== 'build' ? agent : 'Ask'

  const pickMode = (m: 'auto' | 'ask' | 'plan'): void => {
    if (m === 'auto' && mode !== 'auto') {
      appStore.setState({
        confirm: {
          title: 'Enable auto-approve?',
          message:
            'Auto mode auto-approves every permission (file edits, shell commands, web access, etc.) without asking. opencode may run destructive commands or modify any file without confirmation. Use with caution.',
          confirmLabel: 'Enable Auto',
          destructive: true,
          action: () => {
            setMode('auto')
            setAgent('build')
          }
        }
      })
    } else {
      setMode(m)
      setAgent(m === 'plan' ? 'plan' : 'build')
    }
    setOpen(false)
  }

  const pickAgent = (id: string): void => {
    setAgent(id)
    setMode('ask')
    setOpen(false)
  }

  return (
    <div className="model-picker" ref={ref}>
      <button className="model-picker-btn" onClick={() => setOpen((o) => !o)} title="Mode / agent">
        <span className="model-picker-name">{label}</span>
        <span className="model-picker-chevron">
          <ChevronIcon size={12} />
        </span>
      </button>
      {open && (
        <div className="model-picker-pop">
          <div className="model-picker-list">
            <div className="model-section-title">Mode</div>
            <button className={`model-row ${mode === 'auto' ? 'active' : ''}`} onClick={() => pickMode('auto')}>
              <span className="model-row-name">Auto</span>
              <span className="model-row-desc">auto-approve all permissions</span>
            </button>
            <button className={`model-row ${mode === 'ask' && agent === 'build' ? 'active' : ''}`} onClick={() => pickMode('ask')}>
              <span className="model-row-name">Ask</span>
              <span className="model-row-desc">prompt before sensitive actions</span>
            </button>
            <button className={`model-row ${mode === 'plan' ? 'active' : ''}`} onClick={() => pickMode('plan')}>
              <span className="model-row-name">Plan</span>
              <span className="model-row-desc">read-only</span>
            </button>
            {otherAgents.length > 0 && <div className="model-section-title">Agents</div>}
            {otherAgents.map((a) => (
              <button
                key={a.id}
                className={`model-row ${mode === 'ask' && agent === a.id ? 'active' : ''}`}
                onClick={() => pickAgent(a.id)}
                title={a.description}
              >
                <span className="model-row-name">{a.id}</span>
              </button>
            ))}
          </div>
        </div>
      )}
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
  const composerEpoch = useStore(appStore, (s) => s.composerEpoch)
  const attachments = useStore(appStore, (s) => (effectiveSession ? s.attachments[effectiveSession] ?? [] : []))
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [histIdx, setHistIdx] = useState(-1)
  const [draftBackup, setDraftBackup] = useState('')
  const [commands, setCommands] = useState<Command[]>([])
  const [completion, setCompletion] = useState<{ type: 'command' | 'file'; query: string; items: string[]; index: number } | null>(null)
  const history = useStore(appStore, (s) => (effectiveSession ? s.history[effectiveSession] ?? [] : []))

  useEffect(() => {
    void OpenCode.listCommands()
      .then(setCommands)
      .catch(() => {})
  }, [])

  useEffect(() => {
    setHistIdx(-1)
    setDraftBackup('')
    if (effectiveSession) setText(appStore.getState().drafts[effectiveSession] ?? '')
  }, [effectiveSession, composerEpoch])

  useEffect(() => {
    const t = setTimeout(() => {
      if (effectiveSession && text !== (appStore.getState().drafts[effectiveSession] ?? '')) {
        appStore.setState((s) => ({ drafts: { ...s.drafts, [effectiveSession]: text } }))
      }
    }, 300)
    return () => clearTimeout(t)
  }, [text, effectiveSession])

  const completionTrigger = (value: string): { type: 'command' | 'file'; query: string } | null => {
    if (value.startsWith('/') && !value.slice(1).includes(' ')) {
      return { type: 'command', query: value.slice(1).toLowerCase() }
    }
    const m = /(^|\s)@([\w/.\-]*)$/.exec(value)
    if (m) return { type: 'file', query: m[2].toLowerCase() }
    return null
  }

  const refreshCompletion = (value: string): void => {
    const trig = completionTrigger(value)
    if (!trig) {
      setCompletion(null)
      return
    }
    if (trig.type === 'command') {
      const items = commands.filter((c) => c.name.toLowerCase().startsWith(trig.query)).map((c) => c.name)
      setCompletion({ ...trig, items, index: 0 })
    } else {
      setCompletion({ ...trig, items: [], index: 0 })
      if (trig.query) {
        void OpenCode.findFile(trig.query)
          .then((paths) => {
            setCompletion((prev) =>
              prev && prev.type === 'file' && prev.query === trig.query ? { ...prev, items: paths.slice(0, 8) } : prev
            )
          })
          .catch(() => {})
      }
    }
  }

  const insertCompletion = (item: string): void => {
    const value = text
    if (completion?.type === 'command') {
      setText(`/${item} `)
    } else {
      const m = /(^|\s)@([\w/.\-]*)$/.exec(value)
      if (m) {
        const before = value.slice(0, m.index)
        const sep = value[m.index] === '@' ? '' : ' '
        setText(`${before}${sep}@${item} `)
      }
    }
    setCompletion(null)
    autoGrow()
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
    const cmdMatch = /^\/([\w-]+)(?:\s+(.*))?$/.exec(text.trim())
    if (cmdMatch && commands.some((c) => c.name === cmdMatch[1])) {
      if (text.trim()) pushHistory(effectiveSession, text)
      void runCommand(effectiveSession, cmdMatch[1], cmdMatch[2] ?? '')
      setText('')
      setAttachments([])
      setCompletion(null)
      setHistIdx(-1)
      setDraftBackup('')
      if (textareaRef.current) textareaRef.current.style.height = 'auto'
      return
    }
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
    if (completion && completion.items.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setCompletion((c) => (c ? { ...c, index: (c.index + 1) % c.items.length } : c))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setCompletion((c) => (c ? { ...c, index: (c.index - 1 + c.items.length) % c.items.length } : c))
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        insertCompletion(completion.items[completion.index])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setCompletion(null)
        return
      }
    }
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
        {completion && completion.items.length > 0 && (
          <div className="completion-pop">
            {completion.items.map((item, i) => (
              <button
                key={item}
                className={`completion-item ${i === completion.index ? 'active' : ''}`}
                onClick={() => insertCompletion(item)}
                onMouseEnter={() => setCompletion((c) => (c ? { ...c, index: i } : c))}
              >
                <span className={`completion-sigil ${completion.type === 'command' ? 'cmd' : 'file'}`}>
                  {completion.type === 'command' ? '/' : '@'}
                </span>
                <span className="completion-label">{item}</span>
              </button>
            ))}
          </div>
        )}
        <div className="composer-input">
          <textarea
            ref={textareaRef}
            placeholder={hasSession ? 'Ask opencode…' : 'Start a chat to ask opencode'}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              autoGrow()
              refreshCompletion(e.target.value)
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
            <ModePicker />
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

function TurnView({
  turn,
  modelChanged,
  onCtx
}: {
  turn: TurnGroup
  modelChanged?: boolean
  onCtx?: (e: React.MouseEvent, item: MessageWithParts) => void
}): React.JSX.Element {
  const model = turn.assistants[0]?.info.model?.id
  const texts = turn.assistants.flatMap((m) =>
    m.parts
      .filter((p) => p.type === 'text')
      .map((p) => ({ key: p.id, part: p }))
  )
  const lastAssistant = turn.assistants[turn.assistants.length - 1]
  return (
    <>
      {turn.user ? <MessageView item={turn.user} onCtx={onCtx} /> : null}
      {turn.assistants.length > 0 ? (
        <div
          className="msg assistant"
          onContextMenu={onCtx && lastAssistant ? (e) => onCtx(e, lastAssistant) : undefined}
        >
          {onCtx && lastAssistant ? (
            <button className="msg-more" onClick={(e) => onCtx(e, lastAssistant)} title="Message options">
              ⋯
            </button>
          ) : null}
          <MessageError error={lastAssistant.info.error} />
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

const TurnViewMemo = React.memo(TurnView)

export function ChatView({ sessionId }: { sessionId?: string }): React.JSX.Element {
  const activeSessionId = useStore(appStore, (s) => s.activeSessionId)
  const effectiveId = sessionId ?? activeSessionId
  const messages = useStore(appStore, (s) => (effectiveId ? s.messages[effectiveId] ?? [] : []))
  const revertedList = useStore(appStore, (s) => (effectiveId ? s.reverted[effectiveId] : undefined))
  const scrollRef = useRef<HTMLDivElement>(null)
  const [msgCtx, setMsgCtx] = useState<{ x: number; y: number; message: MessageWithParts } | null>(null)
  const msgCtxRef = useRef<HTMLDivElement>(null)

  const revertedIds = useMemo(() => new Set(revertedList ?? []), [revertedList])
  const visible = useMemo(() => messages.filter((m) => !revertedIds.has(m.info.id)), [messages, revertedIds])
  const turns = useMemo(() => groupTurns(visible), [visible])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, effectiveId])

  useEffect(() => {
    if (!msgCtx) return
    const close = (): void => setMsgCtx(null)
    const onDoc = (e: MouseEvent): void => {
      if (msgCtxRef.current && !msgCtxRef.current.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [msgCtx])

  const onMsgCtx = useCallback((e: React.MouseEvent, message: MessageWithParts): void => {
    e.preventDefault()
    setMsgCtx({ x: e.clientX, y: e.clientY, message })
  }, [])

  const menuText = msgCtx ? msgText(msgCtx.message) : ''

  if (!effectiveId) {
    return (
      <div className="chat">
        <div className="empty">
          <img className="hero-mark" src="./icon.png" alt="Ralf" />
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
      {revertedIds.size > 0 && (
        <div className="reverted-banner">
          <span>{revertedIds.size} message{revertedIds.size === 1 ? '' : 's'} reverted — file changes undone.</span>
          <button className="btn-ghost" onClick={() => effectiveId && void unrevertSession(effectiveId)}>
            Undo revert
          </button>
        </div>
      )}
      <div className="messages" ref={scrollRef}>
        {(() => {
          let lastModel: string | undefined
          return turns.map((turn, i) => {
            const model = turn.assistants[0]?.info.model?.id
            const changed = Boolean(model) && model !== lastModel
            if (model) lastModel = model
            return <TurnViewMemo key={i} turn={turn} modelChanged={changed} onCtx={onMsgCtx} />
          })
        })()}
      </div>
      {msgCtx && (
        <div ref={msgCtxRef} className="ctx-menu" style={{ left: Math.min(msgCtx.x, window.innerWidth - 220), top: msgCtx.y }}>
          <button
            className="ctx-item"
            onClick={() => {
              if (effectiveId) {
                appStore.setState({
                  confirm: {
                    title: 'Revert message?',
                    message: 'This removes this message and everything after it.',
                    confirmLabel: 'Revert',
                    destructive: true,
                    action: () => void revertMessage(effectiveId, msgCtx.message.info.id)
                  }
                })
              }
              setMsgCtx(null)
            }}
          >
            Revert
          </button>
          <button
            className="ctx-item"
            onClick={() => {
              if (effectiveId) void editMessage(effectiveId, msgCtx.message.info.id, menuText)
              setMsgCtx(null)
            }}
          >
            Rewrite
          </button>
          <button
            className="ctx-item"
            onClick={() => {
              if (effectiveId) void forkFromMessage(effectiveId, msgCtx.message.info.id)
              setMsgCtx(null)
            }}
          >
            Fork from here
          </button>
          <button
            className="ctx-item"
            onClick={() => {
              void navigator.clipboard.writeText(menuText)
              setMsgCtx(null)
            }}
          >
            Copy text
          </button>
          <button
            className="ctx-item"
            onClick={() => {
              void navigator.clipboard.writeText(msgCtx.message.info.id)
              setMsgCtx(null)
            }}
          >
            Copy ID
          </button>
        </div>
      )}
      <Composer sessionId={sessionId} />
    </div>
  )
}
