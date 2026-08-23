import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useStore, appStore, type Attachment } from '../state/AppState'
import type { MessageWithParts, Part, Command, PermissionRequest, QuestionRequest } from '@shared/opencode'
import type { BackendId, QueuedFollowUp } from '@shared/backend'
import { composerRecovery, retryPayload } from '../lib/send-recovery'
import { abortRun, addAnnotation, clearFailedSend, compactSession, forkFromMessage, moveFollowUp, newChatWithPrompt, onAsrText, openProject, openProjectFolder, pushHistory, refreshFollowUps, rejectQuestion, removeAnnotation, removeFollowUp, respondQuestion, revertMessage, runCommand, selectSession, sendPrompt, setAgent, setLauncherProject, setMode, setModel, setQaPolicy, setVariant, speakText, startSideChat, steerFollowUp, stopSpeaking, toggleAsr, unrevertSession, updateAnnotationNote, updateFollowUp } from '../lib/actions'
import { errorSummary, errorDetails } from '../lib/errors'
import { OpenCode, providerModels } from '../lib/opencode'
import { MessageText } from '../lib/text'
import { AttachmentIcon, ChevronIcon, FileIcon, FolderIcon, ReloadIcon, SendIcon, StopIcon, MicIcon, MicOffIcon, VolumeIcon } from './icons'
import { StepCard } from './StepCard'
import { ModelPicker } from './ModelPicker'
import { BackendControls } from './BackendControls'
import { TokenMeter } from './TokenMeter'
import { BACKEND_SHORT_LABELS } from '../lib/backend-labels'
import { turnCompletedAt } from '../lib/status'
import { segmentTurn } from '../lib/part-runs'
import { retryTurnPayload } from '../lib/regenerate'
import { compactionLabel } from '../lib/compaction'
import { AnnotationHighlights } from './AnnotationHighlights'
import { AnnotationMarkers } from './AnnotationMarkers'
import { AnnotationPopover, type AnnotationPopoverHandle } from './AnnotationPopover'
import { AnnotationRow } from './AnnotationRow'
import { createAnnotation, type Annotation, type AnnotationAnchor } from '@shared/annotations'
import { anchorFromSelection } from '../lib/annotation-anchor'

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
      // An image is shown, not named. Naming it made a screenshot the agent
      // took, or a picture the user attached, into a row of text — the one
      // party who could not see it was the person reading the thread.
      if (part.state?.mime?.startsWith('image/') && part.state.url) {
        const label = part.state.name || path || 'image'
        return (
          <figure className="part-image">
            <img src={part.state.url} alt={label} loading="lazy" />
            <figcaption>{label}</figcaption>
          </figure>
        )
      }
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
    case 'compaction':
      return (
        <div className="compaction-note">
          <span className="compaction-note-icon">✂</span>
          <span>{compactionLabel(part)}</span>
        </div>
      )
    case 'snapshot':
      return null
    default:
      return null
  }
}

/** What the thread is doing right now, for the line pinned under the transcript.
 *
 *  The title carries the argument — the command, the path — where the tool name
 *  alone repeats itself for every call. Prefer it, and keep the name as the
 *  fallback for a backend that sends no title. */
function runningLabel(part: Part): string {
  const title = part.state?.title
  const tool = part.state?.tool || part.state?.name
  if (part.type === 'agent') return `Agent ${title || tool || 'working'}…`
  if (part.type !== 'tool') return 'Working…'
  if (title && tool && title !== tool) return `${tool} — ${title}`
  return `Running ${title || tool || 'tool'}…`
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

function TodoList({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const todos = useStore(appStore, (s) => s.todos[sessionId])
  const [open, setOpen] = useState(true)
  if (!todos || todos.length === 0) return null
  const done = todos.filter((t) => t.status === 'completed' || t.status === 'cancelled').length
  if (done === todos.length) return null
  const running = todos.filter((t) => t.status === 'in_progress').length
  const total = todos.length
  return (
    <div className="todo-list">
      <button className="todo-list-head" onClick={() => setOpen((o) => !o)}>
        <span className="todo-list-chevron" style={{ transform: open ? 'rotate(90deg)' : undefined }}>
          <ChevronIcon size={13} />
        </span>
        <span className="todo-list-title">Todos</span>
        <span className="todo-list-progress">
          {done}/{total} done
        </span>
        {running > 0 ? <span className="spinner-sm" /> : null}
      </button>
      {open && (
        <div className="todo-list-body">
          {todos.map((t) => (
            <div key={t.id} className={`todo-item ${t.status}`}>
              <span className="todo-check">{t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◐' : '○'}</span>
              <span className="todo-content">{t.content}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function PermissionCard({ permission }: { permission: PermissionRequest }): React.JSX.Element | null {
  if (!permission) return null
  const respond = async (response: 'once' | 'always' | 'reject'): Promise<void> => {
    try {
      await OpenCode.respondPermission(permission.sessionID, permission.id, response)
    } catch {
      /* ignore */
    }
    appStore.setState((st) => {
      const permissions = { ...st.permissions }
      delete permissions[permission.sessionID]
      return { permissions }
    })
  }

  const patterns = permission.patterns ?? []
  const cmd = typeof permission.metadata?.command === 'string' ? permission.metadata.command : undefined
  const desc = cmd ?? patterns.join(', ') ?? ''

  return (
    <div className="perm-card">
      <div className="perm-card-head">
        <span className={`perm-card-dot ${permission.permission || 'other'}`} />
        <span className="perm-card-title">{permission.permission || 'permission'}</span>
        <span className="perm-card-waiting">waiting for your approval</span>
      </div>
      {desc ? <div className="perm-card-desc">{desc}</div> : null}
      <div className="perm-card-actions">
        <button className="btn-deny" onClick={() => void respond('reject')}>
          Deny
        </button>
        <button className="btn-allow" onClick={() => void respond('once')}>
          Allow once
        </button>
        <button className="btn-allow" onClick={() => void respond('always')}>
          Always allow
        </button>
      </div>
    </div>
  )
}

function QuestionCard({ question, backendId }: { question: QuestionRequest; backendId: BackendId }): React.JSX.Element | null {
  if (!question) return null
  const [selections, setSelections] = useState<string[][]>(() => question.questions.map(() => []))
  const [custom, setCustom] = useState<string[]>(() => question.questions.map(() => ''))

  const toggle = (idx: number, label: string): void => {
    setSelections((prev) =>
      prev.map((arr, i) => {
        if (i !== idx) return arr
        const q = question.questions[i]
        if (q.multiple) {
          return arr.includes(label) ? arr.filter((l) => l !== label) : [...arr, label]
        }
        return arr.includes(label) ? [] : [label]
      })
    )
  }

  const submit = async (): Promise<void> => {
    const answers = question.questions.map((q, i) => {
      const picked = [...selections[i]]
      const customText = custom[i].trim()
      if (customText && q.custom !== false) picked.push(customText)
      return picked
    })
    await respondQuestion(question.id, answers)
  }

  return (
    <div className="question-card">
      <div className="question-card-head">
        <span className="question-card-dot" />
        <span className="question-card-title">{BACKEND_SHORT_LABELS[backendId]} is asking you</span>
        <span className="question-card-waiting">waiting for your answer</span>
      </div>
      {question.questions.map((q, i) => (
        <div key={i} className="question-item">
          <div className="question-item-text">
            {q.header ? <span className="question-item-header">{q.header}: </span> : null}
            {q.question}
          </div>
          {q.options && q.options.length > 0 ? (
            <div className="question-options">
              {q.options.map((opt) => {
                const active = selections[i].includes(opt.label)
                return (
                  <button key={opt.label} className={`question-option ${active ? 'active' : ''}`} onClick={() => toggle(i, opt.label)}>
                    <span className="question-option-check">{q.multiple ? (active ? '☑' : '☐') : active ? '◉' : '○'}</span>
                    <span className="question-option-label">{opt.label}</span>
                    {opt.description ? <span className="question-option-desc">{opt.description}</span> : null}
                  </button>
                )
              })}
            </div>
          ) : null}
          {q.custom !== false ? (
            <input
              className="question-custom"
              placeholder="Type your own answer…"
              value={custom[i]}
              onChange={(e) => setCustom((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))}
            />
          ) : null}
        </div>
      ))}
      <div className="question-card-actions">
        <button className="btn-deny" onClick={() => void rejectQuestion(question.id)}>
          Dismiss
        </button>
        <button className="btn-allow" onClick={() => void submit()}>
          Submit answer
        </button>
      </div>
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
  const hasCompactionPart = item.parts.some((p) => p.type === 'compaction')
  const hasText = item.parts.some((p) => p.type === 'text' && (p.text ?? '').trim().length > 0)
  if (isUser && hasCompactionPart && !hasText) {
    const compaction = item.parts.find((part) => part.type === 'compaction')!
    return (
      <div className="compaction-divider">
        <span className="compaction-divider-line" />
        <span className="compaction-divider-label">{compactionLabel(compaction)}</span>
        <span className="compaction-divider-line" />
      </div>
    )
  }
  return (
    <div className={`msg ${isUser ? 'user' : 'assistant'}`} onContextMenu={onCtx ? (e) => onCtx(e, item) : undefined}>
      {onCtx ? (
        <button className="msg-more" onClick={(e) => onCtx(e, item)} title="Message options">
          ⋯
        </button>
      ) : null}
      <div className="msg-role">
        <span>{isUser ? 'You' : 'Agent'}</span>
        {item.info.model?.id ? <span className="model">{item.info.model.id}</span> : null}
      </div>
      <MessageError error={item.info.error} />
      <div className="msg-body" data-message-id={isUser ? undefined : item.info.id}>
        {isUser ? (
          item.parts.map((part) => <PartView key={part.id} part={part} />)
        ) : (
          <>
            {segmentTurn(item.parts).map((segment, index) =>
              segment.type === 'narrative' ? (
                <PartView key={segment.part.id} part={segment.part} />
              ) : (
                <StepCard
                  key={`steps-${index}-${segment.parts[0].id}`}
                  message={{ ...item, parts: segment.parts }}
                />
              )
            )}
          </>
        )}
      </div>
    </div>
  )
}

function ModePicker({ backendId, sessionId }: { backendId: BackendId; sessionId?: string }): React.JSX.Element {
  // Main's copy first: it is what actually decides permissions.
  const mode = useStore(appStore, (s) =>
    (sessionId && s.sessions.find((item) => item.id === sessionId)?.mode)
    || (sessionId && s.modesBySession[sessionId])
    || s.mode)
  const pendingMode = useStore(appStore, (s) => (sessionId ? s.modePending[sessionId] : undefined))
  const agent = useStore(appStore, (s) => s.agent)
  const agents = useStore(appStore, (s) => s.agents)
  const descriptor = useStore(appStore, (s) => s.backends.find((backend) => backend.id === backendId))
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
  const otherAgents = backendId === 'opencode' ? agents.filter((a) => a.id && !INTERNAL_AGENTS.has(a.id)) : []
  const modes = descriptor?.modes ?? []
  const selectedMode = modes.find((item) => item.id === mode) ?? modes[0]
  const effectiveMode = selectedMode?.id ?? mode
  const label = backendId === 'opencode' && effectiveMode === 'ask' && agent && agent !== 'build'
    ? agent
    : selectedMode?.label ?? 'Mode'

  const pickMode = (m: typeof mode): void => {
    if (m === 'auto' && effectiveMode !== 'auto') {
      appStore.setState({
        confirm: {
          title: 'Enable auto-approve?',
          message:
            'Auto mode allows the selected backend to approve supported actions without asking. An agent may run destructive commands or modify files. Use with caution.',
          confirmLabel: 'Enable Auto',
          destructive: true,
          action: () => {
            setMode('auto', sessionId ?? null)
            setAgent('build')
          }
        }
      })
    } else {
      setMode(m, sessionId ?? null)
      setAgent(m === 'plan' ? 'plan' : 'build')
    }
    setOpen(false)
  }

  const pickAgent = (id: string): void => {
    setAgent(id)
    setMode('ask', sessionId ?? null)
    setOpen(false)
  }

  if (modes.length <= 1) {
    return (
      <div className="model-picker">
        <button className="model-picker-btn" disabled title={selectedMode?.description ?? 'This backend exposes one execution policy.'}>
          <span className="model-picker-name">{selectedMode?.label ?? 'Backend policy'}</span>
        </button>
      </div>
    )
  }

  return (
    <div className="model-picker" ref={ref}>
      <button
        className="model-picker-btn"
        onClick={() => setOpen((o) => !o)}
        title={pendingMode
          ? `${selectedMode?.label ?? 'Mode'} applies from your next message: this backend fixes its approval policy for the whole turn.`
          : 'Mode / agent'}
      >
        <span className="model-picker-name">{label}{pendingMode ? ' (next turn)' : ''}</span>
        <span className="model-picker-chevron">
          <ChevronIcon size={12} />
        </span>
      </button>
      {open && (
        <div className="model-picker-pop">
          <div className="model-picker-list">
            <div className="model-section-title">Mode</div>
            {modes.map((item) => (
              <button key={item.id} className={`model-row ${effectiveMode === item.id ? 'active' : ''}`} onClick={() => pickMode(item.id)}>
                <span className="model-row-name">{item.label}</span>
                <span className="model-row-desc">{item.description}</span>
              </button>
            ))}
            {otherAgents.length > 0 && <div className="model-section-title">Agents</div>}
            {otherAgents.map((a) => (
              <button
                key={a.id}
                className={`model-row ${effectiveMode === 'ask' && agent === a.id ? 'active' : ''}`}
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

function EffortPicker({ sessionId }: { sessionId?: string }): React.JSX.Element {
  const model = useStore(appStore, (s) => (sessionId && s.modelsBySession[sessionId]) || s.model)
  const modelProvider = useStore(appStore, (s) => (sessionId && s.modelProvidersBySession?.[sessionId]) || s.modelProvider)
  const variant = useStore(appStore, (s) => sessionId && Object.prototype.hasOwnProperty.call(s.variantsBySession, sessionId)
    ? s.variantsBySession[sessionId]
    : s.variant)
  const providers = useStore(appStore, (s) => (sessionId && s.providersBySession[sessionId]) || s.providers)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const currentModel = providers.flatMap((p) => providerModels(p)).find((m) => m.id === model && (!modelProvider || m.providerID === modelProvider))
  const variants = currentModel?.variants ?? []
  if (variants.length === 0) return <></>

  return (
    <div className="model-picker" ref={ref}>
      <button className="model-picker-btn" onClick={() => setOpen((o) => !o)} title="Reasoning effort">
        <span className="model-picker-name">{variant || 'Default'}</span>
        <span className="model-picker-chevron">
          <ChevronIcon size={12} />
        </span>
      </button>
      {open && (
        <div className="model-picker-pop">
          <div className="model-picker-list">
            <div className="model-section-title">Effort</div>
            <button className={`model-row ${!variant ? 'active' : ''}`} onClick={() => { setVariant(null, sessionId ?? null); setOpen(false) }}>
              <span className="model-row-name">Default</span>
            </button>
            {variants.map((v) => (
              <button key={v} className={`model-row ${variant === v ? 'active' : ''}`} onClick={() => { setVariant(v, sessionId ?? null); setOpen(false) }}>
                <span className="model-row-name">{v}</span>
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

const EMPTY_ANNOTATIONS: Annotation[] = []
// Selectors must return a stable reference when a thread has no entry yet.
// `?? []` allocates a fresh array per call, and useSyncExternalStore compares
// with Object.is, so a new array defeats the bail-out and re-renders every
// mounted Composer on every token from every thread.
const EMPTY_ATTACHMENTS: Attachment[] = []
const EMPTY_HISTORY: string[] = []
const EMPTY_FOLLOW_UPS: QueuedFollowUp[] = []

function Composer({ sessionId }: { sessionId?: string }): React.JSX.Element {
  const asrTargetId = React.useId()
  const streaming = useStore(appStore, (s) => (sessionId ?? s.activeSessionId ? Boolean(s.streaming[sessionId ?? s.activeSessionId ?? '']) : false))
  const sessionBusy = useStore(appStore, (s) => (sessionId ?? s.activeSessionId ? Boolean(s.sessionBusy[sessionId ?? s.activeSessionId ?? '']) : false))
  const hasSession = useStore(appStore, (s) => Boolean(sessionId ?? s.activeSessionId))
  const effectiveSession = useStore(appStore, (s) => sessionId ?? s.activeSessionId)
  const sessions = useStore(appStore, (s) => s.sessions)
  const backends = useStore(appStore, (s) => s.backends)
  const defaultBackendId = useStore(appStore, (s) => s.engine)
  const activeSession = effectiveSession ? sessions.find((s) => s.id === effectiveSession) : undefined
  const backendId = activeSession?.backendId ?? defaultBackendId
  const backendLabel = BACKEND_SHORT_LABELS[backendId]
  const supportsAttachments = backends.find((backend) => backend.id === backendId)?.capabilities.images ?? backendId === 'opencode'
  const composerEpoch = useStore(appStore, (s) => s.composerEpoch)
  const attachments = useStore(appStore, (s) => (effectiveSession ? s.attachments[effectiveSession] ?? EMPTY_ATTACHMENTS : EMPTY_ATTACHMENTS))
  const annotations = useStore(appStore, (s) => (effectiveSession ? s.annotations[effectiveSession] ?? EMPTY_ANNOTATIONS : EMPTY_ANNOTATIONS))
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [histIdx, setHistIdx] = useState(-1)
  const [draftBackup, setDraftBackup] = useState('')
  const [commands, setCommands] = useState<Command[]>([])
  const [completion, setCompletion] = useState<{ type: 'command' | 'file'; query: string; items: string[]; index: number } | null>(null)
  const history = useStore(appStore, (s) => (effectiveSession ? s.history[effectiveSession] ?? EMPTY_HISTORY : EMPTY_HISTORY))
  const followUps = useStore(appStore, (s) => (effectiveSession ? s.followUps[effectiveSession] ?? EMPTY_FOLLOW_UPS : EMPTY_FOLLOW_UPS))
  const steering = backends.find((backend) => backend.id === backendId)?.capabilities.steering ?? 'stop-and-redirect'
  const [editingFollowUpId, setEditingFollowUpId] = useState<string | null>(null)
  const [editingFollowUpText, setEditingFollowUpText] = useState('')
  const working = streaming || sessionBusy

  useEffect(() => {
    if (effectiveSession) void refreshFollowUps(effectiveSession)
  }, [effectiveSession])

  useEffect(() => {
    void OpenCode.listCommands()
      .then((items) => setCommands([{ name: 'qa', description: 'Set QA access for this thread: auto, suggest, off, or default', template: '' }, ...items]))
      .catch(() => setCommands([{ name: 'qa', description: 'Set QA access for this thread: auto, suggest, off, or default', template: '' }]))
  }, [])

  // Live dictation: append ASR segments into the current text without
  // clobbering anything the user is typing/editing.
  useEffect(() => {
    const off = onAsrText(({ targetId, text }) => {
      if (targetId !== asrTargetId) return
      setText((prev) => {
        const sep = prev && !prev.endsWith('\n') ? ' ' : ''
        return prev + sep + text
      })
      requestAnimationFrame(() => autoGrow())
    })
    return off
  }, [asrTargetId])

  useEffect(() => {
    setHistIdx(-1)
    setDraftBackup('')
    if (effectiveSession) setText(appStore.getState().drafts[effectiveSession] ?? '')
  }, [effectiveSession, composerEpoch])

  // Resize on every value change, whichever path set it: typing, paste,
  // dictation, completion insert, history recall, draft restore, or the
  // clear after a send.
  useLayoutEffect(() => {
    autoGrow()
  }, [text, attachments.length])

  // A narrower box re-wraps the text, which changes the line count. Watch the
  // element itself so sidebar resizes count, not just window resizes.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    let width = el.clientWidth
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return
      width = el.clientWidth
      autoGrow()
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

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
    if (!effectiveSession || !supportsAttachments || files.length === 0) return
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
    if (!supportsAttachments) return
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
    if (!supportsAttachments) return
    if (e.dataTransfer?.files?.length) void addFiles(Array.from(e.dataTransfer.files))
  }

  const submit = async (): Promise<void> => {
    if (!text.trim() && attachments.length === 0 && annotations.length === 0) return
    if (!effectiveSession) {
      void newChatWithPrompt(text, attachments)
      setText('')
      setAttachments([])
      setCompletion(null)
      setHistIdx(-1)
      setDraftBackup('')
      return
    }
    const cmdMatch = /^\/([\w-]+)(?:\s+(.*))?$/.exec(text.trim())
    if (cmdMatch?.[1] === 'qa') {
      const value = (cmdMatch[2] ?? '').trim().toLowerCase()
      const policy = value === 'auto' || value === 'automatic'
        ? 'automatic'
        : value === 'suggest'
          ? 'suggest'
          : value === 'off'
            ? 'off'
            : value === 'default'
              ? null
              : undefined
      if (policy !== undefined) {
        pushHistory(effectiveSession, text)
        void setQaPolicy(effectiveSession, policy)
        setText('')
        setCompletion(null)
      } else {
        appStore.setState({ lastError: 'Use /qa auto, /qa suggest, /qa off, or /qa default.' })
      }
      return
    }
    if (!working && cmdMatch && commands.some((c) => c.name === cmdMatch[1])) {
      if (text.trim()) pushHistory(effectiveSession, text)
      void runCommand(effectiveSession, cmdMatch[1], cmdMatch[2] ?? '')
      setText('')
      setAttachments([])
      setCompletion(null)
      setHistIdx(-1)
      setDraftBackup('')
      return
    }
    if (text.trim()) pushHistory(effectiveSession, text)
    // Clear optimistically so the composer stays responsive while the send is
    // in flight, then put the text back if it never landed. sendPrompt also
    // records it as a failed send, which is what draws the retry banner — the
    // restore here is so the user can simply press Enter again.
    const pending = text
    const pendingAttachments = attachments
    setText('')
    setAttachments([])
    setHistIdx(-1)
    setDraftBackup('')
    // effectiveSession, not sessionId: the guard above and pushHistory both use
    // it, and sending to a different thread than the composer validated would
    // put the message in a thread the user was not looking at.
    const ok = await sendPrompt(pending, effectiveSession ?? undefined, pendingAttachments)
    if (!ok) {
      // Only restore into an untouched composer. If the user started typing
      // something else while the send was failing, overwriting it would lose
      // that instead — the retry banner still holds the failed text.
      // Read the live values, not this render's closure: `text` still holds the
      // pre-clear string here, which would make every restore look unopposed.
      setText((current) => composerRecovery(ok, pending, [], current, []).text)
      const live = appStore.getState().attachments[effectiveSession] ?? []
      setAttachments(composerRecovery(ok, '', pendingAttachments, '', live).attachments as Attachment[])
    }
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

  const onModelChange = (to: string, providerID: string): void => {
    const state = appStore.getState()
    const sid = sessionId ?? state.activeSessionId
    const current = (sid && state.modelsBySession[sid]) || state.model
    const currentProvider = (sid && state.modelProvidersBySession?.[sid]) || state.modelProvider
    if (to === current && providerID === currentProvider) return
    const hasUserMessage = sid
      ? (state.messages[sid] ?? []).some((message) => message.info.role === 'user')
      : false
    if (hasUserMessage) {
      appStore.setState({ modelSwitch: { to, providerID, sessionId: sid ?? undefined } })
    } else {
      setModel(to, sid, providerID)
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

  // Match the box height to the text. Reset to 'auto' first so scrollHeight
  // reports the shrunk height too, then clamp to the max-height from the
  // stylesheet so the CSS owns the line budget.
  const autoGrow = (): void => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    const max = parseFloat(getComputedStyle(el).maxHeight)
    const next = Number.isFinite(max) ? Math.min(el.scrollHeight, max) : el.scrollHeight
    el.style.height = `${next}px`
  }

  const canSend = text.trim().length > 0 || attachments.length > 0 || annotations.length > 0
  const lastError = useStore(appStore, (s) =>
    effectiveSession ? s.lastErrorBySession[effectiveSession] ?? s.lastError : s.lastError
  )
  const failedSend = useStore(appStore, (s) => (effectiveSession ? s.failedSendBySession[effectiveSession] : undefined))

  const retryFailedSend = async (): Promise<void> => {
    if (!effectiveSession || !failedSend) return
    // Take the text and its attachments from the failed record, not the
    // composer: the user may have typed something else since, and the retry
    // has to resend what actually failed — images included.
    const payload = retryPayload(failedSend)
    if (!payload) return
    const { text: failedText, attachments: failedAttachments } = payload
    clearFailedSend(effectiveSession)
    const ok = await sendPrompt(failedText, effectiveSession, failedAttachments)
    if (ok && text === failedText) {
      // The restored copy in the composer has now been sent; drop it so the
      // user is not looking at a message that is already on its way.
      setText('')
      setAttachments([])
    }
  }

  if (activeSession?.parentID) {
    return (
      <div className="composer-wrap">
        <div className="child-session-bar">
          <span>Subagent sessions cannot be prompted.</span>
          <button className="btn-ghost" onClick={() => void selectSession(activeSession.parentID!)}>
            Back to main session
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="composer-wrap">
      {followUps.length > 0 ? (
        <div className="followup-queue" aria-label="Queued follow-ups">
          <div className="followup-queue-header">
            <span>Up next</span>
            <small>{followUps.length} queued</small>
          </div>
          {followUps.map((followUp, index) => (
            <div className="followup-item" key={followUp.id}>
              <span className="followup-index">{index + 1}</span>
              {editingFollowUpId === followUp.id ? (
                <textarea
                  className="followup-edit"
                  value={editingFollowUpText}
                  autoFocus
                  rows={2}
                  onChange={(event) => setEditingFollowUpText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setEditingFollowUpId(null)
                    if (event.key === 'Enter' && !event.shiftKey && editingFollowUpText.trim()) {
                      event.preventDefault()
                      void updateFollowUp(followUp.threadId, followUp.id, editingFollowUpText)
                      setEditingFollowUpId(null)
                    }
                  }}
                />
              ) : (
                <span className="followup-text">{followUp.text || `${followUp.attachments.length} attachment${followUp.attachments.length === 1 ? '' : 's'}`}</span>
              )}
              <div className="followup-actions">
                {editingFollowUpId === followUp.id ? (
                  <>
                    <button onClick={() => setEditingFollowUpId(null)}>Cancel</button>
                    <button
                      disabled={!editingFollowUpText.trim() && followUp.attachments.length === 0}
                      onClick={() => {
                        void updateFollowUp(followUp.threadId, followUp.id, editingFollowUpText)
                        setEditingFollowUpId(null)
                      }}
                    >
                      Save
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => {
                        setEditingFollowUpId(followUp.id)
                        setEditingFollowUpText(followUp.text)
                      }}
                    >
                      Edit
                    </button>
                    <button disabled={index === 0} onClick={() => void moveFollowUp(followUp.threadId, followUp.id, index - 1)} title="Move earlier">↑</button>
                    <button disabled={index === followUps.length - 1} onClick={() => void moveFollowUp(followUp.threadId, followUp.id, index + 1)} title="Move later">↓</button>
                    <button
                      className="followup-steer"
                      onClick={() => void steerFollowUp(followUp.threadId, followUp.id)}
                      title={!working ? 'Retry this queued message now' : steering === 'native' ? 'Add this instruction to the active run' : 'Stop the current run and send this instruction next'}
                    >
                      {!working ? 'Retry now' : steering === 'native' ? 'Steer now' : 'Stop & redirect'}
                    </button>
                    <button className="followup-delete" onClick={() => void removeFollowUp(followUp.threadId, followUp.id)}>Delete</button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {lastError ? (
        <div className="chat-error">
          <span className="chat-error-icon">!</span>
          <span className="chat-error-text">{lastError}</span>
          {failedSend ? (
            <button
              className="chat-error-retry"
              onClick={() => void retryFailedSend()}
              title={
                failedSend.attachments.length
                  ? `Send this message again, with ${failedSend.attachments.length} attachment${failedSend.attachments.length === 1 ? '' : 's'}`
                  : 'Send this message again'
              }
            >
              Retry
            </button>
          ) : null}
          <button
            className="chat-error-close"
            onClick={() => {
              if (effectiveSession) clearFailedSend(effectiveSession)
              appStore.setState((st) => ({
                lastError: null,
                lastErrorBySession: effectiveSession
                  ? { ...st.lastErrorBySession, [effectiveSession]: '' }
                  : st.lastErrorBySession
              }))
            }}
            title="Dismiss"
          >
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
        {effectiveSession ? (
          <AnnotationRow
            annotations={annotations}
            onRemove={(id) => removeAnnotation(effectiveSession, id)}
          />
        ) : null}
        <div className="composer-input">
          <textarea
            ref={textareaRef}
            placeholder={hasSession ? working ? `Queue a follow-up for ${backendLabel}…` : `Ask ${backendLabel}…` : 'Start a thread'}
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
            <button
              className="composer-attach"
              disabled={!supportsAttachments}
              onClick={() => fileInputRef.current?.click()}
              title={supportsAttachments ? 'Attach file or image' : `${backendLabel} attachments are not wired into BOSS yet`}
            >
              <AttachmentIcon size={16} />
            </button>
            <MicToggle targetId={asrTargetId} />
            {effectiveSession ? <BackendControls sessionId={effectiveSession} /> : null}
            <ModePicker backendId={backendId} sessionId={effectiveSession ?? undefined} />
            <ModelPicker onPick={onModelChange} sessionId={effectiveSession ?? undefined} />
            <EffortPicker sessionId={effectiveSession ?? undefined} />
            {effectiveSession ? <TokenMeter sessionId={effectiveSession} /> : null}
          </div>
          <div className="composer-submit-actions">
            {working ? (
              <button className="btn-stop-secondary" onClick={() => void abortRun(effectiveSession ?? undefined)} title="Stop current run">
                <StopIcon size={14} />
              </button>
            ) : null}
            <button className="btn-send" disabled={!canSend} onClick={submit} title={working ? 'Queue follow-up' : 'Send'}>
              <SendIcon size={16} />
            </button>
          </div>
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

function MicToggle({ targetId }: { targetId: string }): React.JSX.Element {
  const asr = useStore(appStore, (s) => s.asr)
  const activeTargetId = useStore(appStore, (s) => s.asrTargetId)
  const listening = asr.listening && activeTargetId === targetId
  const anotherComposerIsListening = asr.listening && !listening
  return (
    <button
      className={`composer-mic ${listening ? 'active' : ''}`}
      disabled={anotherComposerIsListening}
      onClick={() => void toggleAsr(targetId)}
      title={listening ? 'Stop voice input' : anotherComposerIsListening ? 'Voice input is active in another composer' : 'Speak to type'}
    >
      {listening ? <MicOffIcon size={16} /> : <MicIcon size={16} />}
    </button>
  )
}

interface TurnGroup {
  user?: MessageWithParts
  assistants: MessageWithParts[]
}

function uniqueNarrativeParts(parts: Part[]): Part[] {
  const seen = new Set<string>()
  return parts.filter((part) => {
    if (part.type !== 'text' && part.type !== 'reasoning') return true
    const text = (part.text ?? part.state?.text ?? '').replace(/\s+/g, ' ').trim()
    if (!text) return true
    // `parts` is one assistant turn. A backend can assign its live and history
    // copies different message ids, so including messageID here preserved the
    // exact duplicate this helper exists to remove.
    const key = `${part.type}\u0000${text}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
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

/** One message standing for every assistant message in a turn.
 *
 *  A turn with no reply yet is normal, not a mistake: groupTurns opens a group
 *  the moment the user sends, and it stays empty until the first message
 *  arrives. Returning an empty message rather than reading info off a message
 *  that is not there keeps that first frame renderable. */
function combineAssistants(messages: MessageWithParts[]): MessageWithParts {
  if (messages.length === 0) return { info: {} as MessageWithParts['info'], parts: [] }
  const parts = uniqueNarrativeParts(messages.flatMap((m) => m.parts))
  const created = Math.min(...messages.map((m) => m.info.time?.created).filter((t): t is number => typeof t === 'number'))
  // A turn is finished only when every message in it is. Taking the latest
  // completion regardless reported a turn as done while one of its messages was
  // still running, which is the field the rest of the UI reads to decide
  // whether a thread is still working.
  const completed = turnCompletedAt(messages.map((m) => m.info.time?.completed))
  return {
    info: {
      ...messages[0].info,
      time: {
        created: Number.isFinite(created) ? created : undefined,
        completed
      }
    },
    parts
  }
}

function TurnView({
  turn,
  modelChanged,
  sessionId,
  onCtx
}: {
  turn: TurnGroup
  modelChanged?: boolean
  sessionId?: string
  onCtx?: (e: React.MouseEvent, item: MessageWithParts) => void
}): React.JSX.Element {
  const model = turn.assistants[0]?.info.model?.id
  const combined = combineAssistants(turn.assistants)
  const segments = segmentTurn(combined.parts)
  const parts = combined.parts
  const speakable = parts
    .filter((p) => p.type === 'text')
    .map((part) => partText(part))
    .filter(Boolean)
    .join('\n')
  const lastAssistant = turn.assistants[turn.assistants.length - 1]
  // Playback state lives in the store, not local state: the auto-speak effect
  // starts audio outside this component, and its key is what names the turn
  // whose button becomes the stop control.
  const speakingKey = useStore(appStore, (s) => s.speakingKey)
  const speakingThis = Boolean(lastAssistant && speakingKey === lastAssistant.info.id)
  const working = useStore(appStore, (s) =>
    sessionId ? Boolean(s.streaming[sessionId] || s.sessionBusy[sessionId]) : false)
  // A completed reply with a real prompt behind it can be asked for again.
  // Resending is an ordinary send — history is never truncated — so every
  // backend qualifies; a busy thread disqualifies itself by disabling.
  const retryPayload = useMemo(
    () => (turn.user && lastAssistant?.info.time?.completed ? retryTurnPayload(turn.user) : null),
    [turn.user, lastAssistant]
  )
  return (
    <>
      {turn.user ? <MessageView item={turn.user} onCtx={onCtx} /> : null}
      {turn.assistants.length > 0 ? (
        <div
          className="msg assistant"
          onContextMenu={onCtx && lastAssistant ? (e) => onCtx(e, lastAssistant) : undefined}
        >
          {/* Inside msg-actions, not beside it: both anchor to the top-right
              corner, and a sibling rendered first sat underneath the actions
              row, which swallowed every click meant for it. */}
          <div className="msg-actions">
            {onCtx && lastAssistant ? (
              <button className="msg-more" onClick={(e) => onCtx(e, lastAssistant)} title="Message options">
                ⋯
              </button>
            ) : null}
            {retryPayload && !working ? (
              <button
                className="msg-speak"
                onClick={() => {
                  if (!sessionId || working) return
                  void sendPrompt(retryPayload.text, sessionId, retryPayload.attachments)
                }}
                disabled={working}
                title="Retry this turn"
              >
                <ReloadIcon size={14} />
              </button>
            ) : null}
            {speakable ? (
              speakingThis ? (
                <button className="msg-speak active" onClick={() => stopSpeaking()} title="Stop reading">
                  <StopIcon size={14} />
                </button>
              ) : (
                <button
                  className="msg-speak"
                  onClick={() => void speakText(speakable, lastAssistant.info.id)}
                  title="Read aloud"
                >
                  <VolumeIcon size={14} />
                </button>
              )
            ) : null}
          </div>
          <MessageError error={lastAssistant.info.error} />
          <div className="msg-body" data-message-id={lastAssistant.info.id}>
            {modelChanged && model ? <span className="model-chip">{model}</span> : null}
            {/* Stream order, so each card sits under the line that introduced
                it. One card for the whole turn put a long run's calls far above
                the prose explaining them. */}
            {segments.map((segment, index) =>
              segment.type === 'narrative' ? (
                <PartView key={segment.part.id} part={segment.part} />
              ) : (
                <StepCard
                  key={`steps-${index}-${segment.parts[0].id}`}
                  message={{ ...combined, parts: segment.parts }}
                />
              )
            )}
          </div>
        </div>
      ) : null}
    </>
  )
}

const TurnViewMemo = React.memo(TurnView)

export function ChatView({ sessionId, active = true }: { sessionId?: string; active?: boolean }): React.JSX.Element {
  const activeSessionId = useStore(appStore, (s) => s.activeSessionId)
  const effectiveId = sessionId ?? activeSessionId
  const messages = useStore(appStore, (s) => (effectiveId ? s.messages[effectiveId] ?? [] : []))
  const backendId = useStore(appStore, (s) => s.sessions.find((session) => session.id === effectiveId)?.backendId ?? 'opencode')
  /** Where this thread works, named the way the bar names it: the branch when
   *  the thread has a worktree, otherwise the project folder. Used only by the
   *  empty state, to ask about somewhere concrete rather than in the abstract. */
  const threadPlace = useStore(appStore, (s) => {
    const session = s.sessions.find((item) => item.id === effectiveId)
    if (!session) return undefined
    if (session.worktree?.status === 'active' && session.worktree.branch) return session.worktree.branch
    const path = session.projectPath ?? session.directory ?? session.path
    return path ? path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) : undefined
  })
  const historyCapabilities = useStore(appStore, (s) => s.backends.find((backend) => backend.id === backendId)?.capabilities)
  // Raw record, not a defaulted array: a fresh [] each evaluation would defeat
  // the subscription's equality check and re-render on every store change.
  const reverted = useStore(appStore, (s) => (effectiveId ? s.reverted[effectiveId] : undefined))
  const projects = useStore(appStore, (s) => s.projects)
  const scrollRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const searchRestoreFocusRef = useRef<HTMLElement | null>(null)
  /** Whether to keep the view pinned to the newest output. A ref, not state:
   *  the follow observer must not be torn down every time this flips, and it
   *  is decided by the user scrolling rather than by a render. */
  const followRef = useRef(true)
  const [msgCtx, setMsgCtx] = useState<{
    x: number
    y: number
    message: MessageWithParts
    /** The passage selected when the menu opened, if it sits in this message. */
    selection: { quote: string; anchor: AnnotationAnchor } | null
  } | null>(null)
  const msgCtxRef = useRef<HTMLDivElement>(null)
  const launcherProject = useStore(appStore, (s) => s.launcherProject)

  const streaming = useStore(appStore, (s) => (effectiveId ? Boolean(s.streaming[effectiveId]) : false))
  const compacting = useStore(appStore, (s) => (effectiveId ? Boolean(s.compacting[effectiveId]) : false))
  const permission = useStore(appStore, (s) => (effectiveId ? s.permissions[effectiveId] ?? null : null))
  const question = useStore(appStore, (s) => (effectiveId ? s.questions[effectiveId] ?? null : null))
  const visible = messages
  const WINDOW = 100
  const PAGE = 200
  const [visibleCount, setVisibleCount] = useState(WINDOW)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchMatchCount, setSearchMatchCount] = useState(0)
  const [activeSearchMatch, setActiveSearchMatch] = useState(0)

  useEffect(() => {
    setVisibleCount(WINDOW)
  }, [effectiveId])

  // Find is deliberately scoped to a thread, including history outside the
  // ordinary rolling transcript window. Rendering that extra history only
  // while there is a query keeps normal long-running threads lightweight.
  const windowed = useMemo(
    () => searchOpen && searchQuery.trim() ? visible : visible.slice(-visibleCount),
    [visible, visibleCount, searchOpen, searchQuery]
  )
  const turns = useMemo(() => groupTurns(windowed), [windowed])
  const annotationsForThread = useStore(appStore, (s) => (effectiveId ? s.annotations[effectiveId] ?? EMPTY_ANNOTATIONS : EMPTY_ANNOTATIONS))
  // Lets a numbered marker in the transcript reopen the note editor on the
  // annotation it belongs to, which is what makes a placed highlight editable.
  const annotationPopoverRef = useRef<AnnotationPopoverHandle>(null)
  const lastTurnAssistants = turns[turns.length - 1]?.assistants ?? []
  const allParts = lastTurnAssistants.flatMap((m) => m.parts)
  const liveText = allParts.some((p) => p.type === 'text' && (p.text ?? '').trim().length > 0)
  const runningPart = allParts.find((p) => p.state?.status === 'running' || p.state?.status === 'pending')
  const waitingForReply = visible[visible.length - 1]?.info.role === 'user'
  // While the thread streams, always show a label: the running tool when one is
  // active, 'Thinking' before any reply text, 'Working' between text and tools.
  const activity = compacting
    ? 'Compacting context'
    : streaming
      ? (runningPart ? runningLabel(runningPart) : waitingForReply || !liveText ? 'Thinking' : 'Working')
      : null
  const expandingRef = useRef(false)

  const closeSearch = useCallback((): void => {
    setSearchOpen(false)
    setSearchQuery('')
    setSearchMatchCount(0)
    setActiveSearchMatch(0)
    requestAnimationFrame(() => searchRestoreFocusRef.current?.focus({ preventScroll: true }))
  }, [])

  const moveSearchMatch = useCallback((step: number): void => {
    if (searchMatchCount === 0) return
    setActiveSearchMatch((current) => (current + step + searchMatchCount) % searchMatchCount)
  }, [searchMatchCount])

  useEffect(() => {
    if (!searchOpen) return
    searchInputRef.current?.focus()
    searchInputRef.current?.select()
  }, [searchOpen])

  useLayoutEffect(() => {
    const query = searchQuery.trim().toLocaleLowerCase()
    const messageElements = Array.from(scrollRef.current?.querySelectorAll<HTMLElement>('.msg') ?? [])
    const matches = query
      ? messageElements.filter((element) => element.textContent?.toLocaleLowerCase().includes(query))
      : []
    const next = matches.length ? Math.min(activeSearchMatch, matches.length - 1) : 0

    for (const element of messageElements) element.classList.remove('thread-search-match', 'thread-search-current')
    for (const element of matches) element.classList.add('thread-search-match')
    if (matches[next]) {
      matches[next].classList.add('thread-search-current')
      matches[next].scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
    if (next !== activeSearchMatch) setActiveSearchMatch(next)
    if (matches.length !== searchMatchCount) setSearchMatchCount(matches.length)
  }, [searchQuery, activeSearchMatch, searchMatchCount, windowed])

  useEffect(() => {
    if (!active) return
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'f') {
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()
        if (!searchOpen) {
          searchRestoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
        }
        setSearchOpen(true)
        return
      }
      if (!searchOpen) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()
        closeSearch()
      } else if (event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()
        moveSearchMatch(event.shiftKey ? -1 : 1)
      }
    }
    // Capture lets Find close before the app-level Escape handler can abort a
    // working thread, matching the expectation that Escape dismisses Find.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [active, searchOpen, closeSearch, moveSearchMatch])

  const speakAloud = useStore(appStore, (s) => s.speakAloud)
  const spokenRef = useRef<Set<string>>(new Set())
  const baselineMsgIdRef = useRef<Record<string, string>>({})
  const baselineSetRef = useRef(false)
  const prevSessionRef = useRef<string | null>(null)
  useEffect(() => {
    if (!effectiveId) {
      prevSessionRef.current = null
      baselineSetRef.current = false
      return
    }
    if (prevSessionRef.current !== effectiveId) {
      prevSessionRef.current = effectiveId
      baselineSetRef.current = false
      return
    }
    if (!baselineSetRef.current) {
      const lastAssistant = turns[turns.length - 1]?.assistants[turns[turns.length - 1]?.assistants.length - 1]
      if (!lastAssistant) return // messages not loaded yet — wait
      // First stable view of this session: snapshot the last message id so we
      // never read out historical messages when clicking into a session.
      baselineSetRef.current = true
      baselineMsgIdRef.current[effectiveId] = lastAssistant.info.id
      return
    }
    if (!speakAloud) return
    const lastAssistant = turns[turns.length - 1]?.assistants[turns[turns.length - 1]?.assistants.length - 1]
    if (!lastAssistant) return
    if (!lastAssistant.info.time?.completed) return
    // Only speak genuinely fresh responses. Historical messages (completed long
    // ago, e.g. when clicking into an old session) must never be read aloud.
    const completed = lastAssistant.info.time.completed
    if (Date.now() - completed > 30_000) return
    // Only speak if a brand-new message appeared since we entered the session.
    if (lastAssistant.info.id === baselineMsgIdRef.current[effectiveId]) return
    baselineMsgIdRef.current[effectiveId] = lastAssistant.info.id
    const text = msgText(lastAssistant)
    if (!text.trim()) return
    const key = `${effectiveId}:${lastAssistant.info.id}:${text}`
    if (spokenRef.current.has(key)) return
    spokenRef.current.add(key)
    if (spokenRef.current.size > 200) spokenRef.current = new Set([...spokenRef.current].slice(-100))
    // Tagged with the message id, so the turn being read shows its stop control.
    void speakText(text, lastAssistant.info.id)
  }, [turns, speakAloud, effectiveId])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    // Scrolling up to read stops the follow; coming back resumes it. The
    // threshold is generous because a streamed line can land between the
    // scroll and this handler.
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    if (expandingRef.current) return
    if (visible.length <= windowed.length) return
    if (el.scrollTop < 120) {
      expandingRef.current = true
      const before = el.scrollHeight
      setVisibleCount((c) => c + PAGE)
      requestAnimationFrame(() => {
        if (el) el.scrollTop += el.scrollHeight - before
        expandingRef.current = false
      })
    }
  }

  useEffect(() => {
    const el = scrollRef.current
    // A new thread starts at the bottom, following. Carrying the last one's
    // position over would leave you reading history you never scrolled to.
    followRef.current = true
    if (el) el.scrollTop = el.scrollHeight
    const t1 = setTimeout(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }, 150)
    const t2 = setTimeout(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }, 600)
    return () => {
      clearTimeout(t1)
      clearTimeout(t2)
    }
  }, [effectiveId])

  // Follow the conversation while it is at the bottom.
  //
  // This used to fire on messages.length, which does not change while a reply
  // streams — the text grows inside the last message. So the view sat still
  // through the whole response, and Thinking looked cut off because its
  // message was already counted. Watching the element covers every way the
  // content can grow: streamed text, an expanding tool block, an image
  // finishing its load.
  //
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const stick = (): void => {
      // Not while older messages are being prepended: that path is holding the
      // scroll position deliberately, and jumping to the bottom would undo it.
      if (followRef.current && !expandingRef.current) el.scrollTop = el.scrollHeight
    }
    const observer = new ResizeObserver(stick)
    for (const child of el.children) observer.observe(child)
    const mutations = new MutationObserver(() => {
      for (const child of el.children) observer.observe(child)
      stick()
    })
    mutations.observe(el, { childList: true })
    return () => {
      observer.disconnect()
      mutations.disconnect()
    }
  }, [effectiveId])

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
    // Read the selection now, not when the item is clicked. Opening the menu
    // moves focus and a later click on the item collapses the selection, so by
    // then there is nothing left to annotate.
    const found = anchorFromSelection(window.getSelection())
    // Only offer the passage if it belongs to the message actually
    // right-clicked; a selection left over in a different message would attach
    // the note to words this menu does not describe.
    const selection = found && found.anchor.messageId === message.info.id ? found : null
    setMsgCtx({
      x: e.clientX,
      y: e.clientY,
      message,
      selection: selection ? { quote: selection.quote, anchor: selection.anchor } : null
    })
  }, [])

  const menuText = msgCtx ? msgText(msgCtx.message) : ''

  if (!effectiveId) {
    return (
      <div className="chat">
        <div className="empty">
          <h2>How can I help you today?</h2>
          <div className="launcher-composer">
            <div className="launcher-project-row">
              <span className="launcher-project-label">Chat in</span>
              <select
                className="launcher-project-select"
                value={launcherProject ?? ''}
                onChange={(e) => {
                  if (e.target.value === '__new__') {
                    void openProjectFolder()
                  } else {
                    setLauncherProject(e.target.value === '' ? null : e.target.value)
                  }
                }}
              >
                <option value="">Just a chat (no project)</option>
                {projects.map((p) => {
                  const path = p.worktree ?? p.directory ?? p.path
                  if (!path) return null
                  return (
                    <option key={path} value={path}>
                      {path.split('/').pop()}
                    </option>
                  )
                })}
                <option value="__new__">New project…</option>
              </select>
            </div>
            <Composer />
          </div>
          <div className="actions">
            <button className="action" onClick={() => void openProjectFolder()}>
              <span className="icon">
                <FolderIcon size={15} />
              </span>
              New project
            </button>
          </div>
          {projects.length > 0 ? (
            <div className="recent-projects">
              <div className="section-label">Open a project</div>
              {projects.slice(0, 6).map((p) => {
                const path = p.worktree ?? p.directory ?? p.path
                if (!path) return null
                return (
                  <button key={path} className="recent-project" onClick={() => void openProject(path)} title={path}>
                    <FolderIcon size={13} />
                    <span>{path.split('/').pop()}</span>
                  </button>
                )
              })}
            </div>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <div className="chat">
      <div className="chat-messages-area">
        {searchOpen ? (
          <div className="thread-search" role="search" aria-label="Search this thread">
            <input
              ref={searchInputRef}
              className="thread-search-input"
              type="search"
              placeholder="Find in thread"
              aria-label="Find in thread"
              value={searchQuery}
              onChange={(event) => {
                setSearchQuery(event.target.value)
                setActiveSearchMatch(0)
              }}
            />
            <span className="thread-search-count" aria-live="polite">
              {searchQuery.trim() ? (searchMatchCount ? `${activeSearchMatch + 1} of ${searchMatchCount}` : 'No matches') : 'Find text'}
            </span>
            <button className="thread-search-button" type="button" onClick={() => moveSearchMatch(-1)} disabled={searchMatchCount === 0} aria-label="Previous match" title="Previous match (Shift+Enter)">↑</button>
            <button className="thread-search-button" type="button" onClick={() => moveSearchMatch(1)} disabled={searchMatchCount === 0} aria-label="Next match" title="Next match (Enter)">↓</button>
            <button className="thread-search-button close" type="button" onClick={closeSearch} aria-label="Close thread search" title="Close (Escape)">×</button>
          </div>
        ) : null}
        {effectiveId ? (
          <AnnotationHighlights
            annotations={annotationsForThread}
            scrollRef={scrollRef}
            revision={turns}
          />
        ) : null}
        {effectiveId ? (
          <AnnotationMarkers
            annotations={annotationsForThread}
            scrollRef={scrollRef}
            revision={turns}
            onEdit={(annotation, at) => annotationPopoverRef.current?.edit(annotation, at)}
          />
        ) : null}
        {effectiveId ? (
          <AnnotationPopover
            handleRef={annotationPopoverRef}
            scrollRef={scrollRef}
            onAnnotate={(quote, anchor, note) => addAnnotation(effectiveId, quote, anchor, note)}
            onUpdateNote={(id, note) => updateAnnotationNote(effectiveId, id, note)}
            onRemove={(id) => removeAnnotation(effectiveId, id)}
            onSideChat={(quote, anchor) => {
              // Built without touching the composer: a side chat carries the
              // passage somewhere else, so pinning it to this thread's draft
              // would leave a stray quote behind here.
              void startSideChat(
                effectiveId,
                createAnnotation(`annotation-${crypto.randomUUID()}`, quote, anchor)
              )
            }}
          />
        ) : null}
        <div className="messages" ref={scrollRef} onScroll={onScroll}>
          {/* A thread with nothing in it yet showed a blank half-window above
              the composer, which reads as something failing to load rather than
              as a thread waiting for its first instruction. Naming where the
              thread works makes the ask concrete. */}
          {turns.length === 0 && !activity ? (
            <div className="thread-start">
              <h2>{threadPlace ? `What should we do in ${threadPlace}?` : 'What should we do?'}</h2>
              <p>Describe the change you want, or ask about the code. {BACKEND_SHORT_LABELS[backendId]} works in this thread.</p>
            </div>
          ) : null}
          {(() => {
            let lastModel: string | undefined
            return turns.map((turn, i) => {
              const model = turn.assistants[0]?.info.model?.id
              const changed = Boolean(model) && model !== lastModel
              if (model) lastModel = model
              return <TurnViewMemo key={i} turn={turn} modelChanged={changed} sessionId={effectiveId} onCtx={onMsgCtx} />
            })
          })()}
          {activity ? (
            <div className="thinking-indicator">
              <span>{activity}</span>
              <span className="thinking-dots">
                <span>.</span>
                <span>.</span>
                <span>.</span>
              </span>
            </div>
          ) : null}
          {permission ? <PermissionCard permission={permission} /> : null}
          {question ? <QuestionCard question={question} backendId={backendId} /> : null}
        </div>
      </div>
      {msgCtx && (
        <div ref={msgCtxRef} className="ctx-menu" style={{ left: Math.min(msgCtx.x, window.innerWidth - 220), top: msgCtx.y }}>
          {msgCtx.message.info.role === 'user' ? (
            <button
              className="ctx-item"
              onClick={() => {
                if (effectiveId) void forkFromMessage(
                  effectiveId,
                  historyCapabilities?.branching === 'message' ? msgCtx.message.info.id : undefined
                )
                setMsgCtx(null)
              }}
            >
              {historyCapabilities?.branching === 'message' ? 'Branch from here' : 'Duplicate thread'}
            </button>
          ) : null}
          {msgCtx.message.info.role === 'user' && historyCapabilities?.branching === 'message' ? (
            <button
              className="ctx-item"
              onClick={() => {
                if (effectiveId) void forkFromMessage(effectiveId, msgCtx.message.info.id, menuText)
                setMsgCtx(null)
              }}
            >
              Edit in new branch…
            </button>
          ) : null}
          {/* The affordance people reach for first. The selection toolbar is
              easy to miss, so the passage is annotatable from the menu too —
              absent, rather than inert, when there is nothing selected here.
              Attaches the quote with no note, which is a complete annotation on
              its own; the marker it leaves in the transcript is how a note gets
              added afterwards. */}
          {msgCtx.selection ? (
            <button
              className="ctx-item"
              onClick={() => {
                const selected = msgCtx.selection
                if (selected && effectiveId) {
                  addAnnotation(effectiveId, selected.quote, selected.anchor, '')
                  window.getSelection()?.removeAllRanges()
                }
                setMsgCtx(null)
              }}
            >
              Annotate
            </button>
          ) : null}
          <button
            className="ctx-item"
            onClick={() => {
              window.boss.clipboardWrite(menuText)
              setMsgCtx(null)
            }}
          >
            Copy text
          </button>
          {/* Only where the backend implements revert: elsewhere the item would
              promise an undo that drops nothing. */}
          {historyCapabilities?.revert && msgCtx.message.info.id ? (
            <button
              className="ctx-item"
              onClick={() => {
                if (effectiveId) void revertMessage(effectiveId, msgCtx.message.info.id)
                setMsgCtx(null)
              }}
            >
              Undo to here
            </button>
          ) : null}
          {historyCapabilities?.revert && reverted && reverted.length > 0 ? (
            <button
              className="ctx-item"
              onClick={() => {
                if (effectiveId) void unrevertSession(effectiveId)
                setMsgCtx(null)
              }}
            >
              Restore undone messages
            </button>
          ) : null}
          {historyCapabilities?.compact ? (
            <button
              className="ctx-item"
              onClick={() => {
                const target = effectiveId
                appStore.setState({
                  confirm: {
                    title: 'Compact this thread?',
                    message:
                      'Earlier messages will be summarized and their full text will no longer be shown in the transcript. The agent continues from the summary.',
                    confirmLabel: 'Compact',
                    action: () => {
                      if (target) void compactSession(target)
                    }
                  }
                })
                setMsgCtx(null)
              }}
            >
              Compact context…
            </button>
          ) : null}
        </div>
      )}
      {effectiveId ? <TodoList sessionId={effectiveId} /> : null}
      <Composer sessionId={sessionId} />
    </div>
  )
}
