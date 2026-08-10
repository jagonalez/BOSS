import React, { useEffect, useRef, useState } from 'react'
import { useStore, appStore } from '../state/AppState'
import type { MessageWithParts, Part } from '@shared/opencode'
import { abortRun, newSession, openProjectFolder, sendPrompt } from '../lib/actions'
import { providerModels } from '../lib/opencode'
import { MessageText } from '../lib/text'
import { ChevronIcon, FolderIcon, PlusIcon, SendIcon, StopIcon } from './icons'

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

function MessageView({ item }: { item: MessageWithParts }): React.JSX.Element {
  const isUser = item.info.role === 'user'
  return (
    <div className={`msg ${isUser ? 'user' : 'assistant'}`}>
      <div className="msg-role">
        <span>{isUser ? 'You' : 'opencode'}</span>
        {item.info.model?.id ? <span className="model">{item.info.model.id}</span> : null}
      </div>
      <div className="msg-body">
        {item.parts.map((part) => (
          <PartView key={part.id} part={part} />
        ))}
      </div>
    </div>
  )
}

function Composer({ sessionId }: { sessionId?: string }): React.JSX.Element {
  const [text, setText] = useState('')
  const streaming = useStore(appStore, (s) => s.streaming)
  const model = useStore(appStore, (s) => s.model)
  const providers = useStore(appStore, (s) => s.providers)
  const hasSession = useStore(appStore, (s) => Boolean(sessionId ?? s.activeSessionId))
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const submit = (): void => {
    if (!text.trim() || !hasSession) return
    void sendPrompt(text, sessionId)
    setText('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  const autoGrow = (): void => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }

  return (
    <div className="composer-wrap">
      <div className="composer">
        <textarea
          ref={textareaRef}
          placeholder={hasSession ? 'Ask opencode…' : 'Start a chat to ask opencode'}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            autoGrow()
          }}
          onKeyDown={onKeyDown}
          rows={1}
        />
        <div className="row">
          {providers.length > 0 && (
            <select value={model ?? ''} onChange={(e) => appStore.setState({ model: e.target.value })}>
              {providers.flatMap((p) =>
                providerModels(p).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                  </option>
                ))
              )}
            </select>
          )}
          {streaming ? (
            <button className="btn-send" onClick={() => void abortRun()} title="Stop">
              <StopIcon size={16} />
            </button>
          ) : (
            <button className="btn-send" disabled={!text.trim() || !hasSession} onClick={submit} title="Send">
              <SendIcon size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
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
        {messages.map((item) => (
          <MessageView key={item.info.id} item={item} />
        ))}
      </div>
      <Composer sessionId={sessionId} />
    </div>
  )
}
