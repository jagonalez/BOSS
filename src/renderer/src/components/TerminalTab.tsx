import React, { useEffect, useRef, useState } from 'react'
import { useStore, appStore } from '../state/AppState'
import { OpenCode } from '../lib/opencode'

interface TermLine {
  cmd: string
  out: string
}

function extractOutput(text: string): string {
  try {
    const parts = JSON.parse(text)
    if (Array.isArray(parts)) {
      return parts
        .map((p) => {
          const v = p?.state?.text ?? p?.state?.output ?? p?.state?.content ?? p?.state?.title ?? ''
          return typeof v === 'string' ? v : JSON.stringify(v)
        })
        .filter(Boolean)
        .join('\n')
    }
  } catch {
    /* not json */
  }
  return text
}

export function TerminalTab(): React.JSX.Element {
  const sessionID = useStore(appStore, (s) => s.activeSessionId)
  const [input, setInput] = useState('')
  const [lines, setLines] = useState<TermLine[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  useEffect(() => {
    inputRef.current?.focus()
  }, [sessionID])

  const run = async (): Promise<void> => {
    const cmd = input.trim()
    if (!cmd || !sessionID) return
    setInput('')
    setLines((l) => [...l, { cmd, out: '' }])
    try {
      const res = await OpenCode.shell(sessionID, cmd)
      const text = JSON.stringify(res)
      const out = extractOutput(text).trim()
      setLines((l) => {
        const next = [...l]
        next[next.length - 1] = { cmd, out: out || '✓' }
        return next
      })
    } catch (err) {
      setLines((l) => {
        const next = [...l]
        next[next.length - 1] = { cmd, out: String((err as Error).message ?? err) }
        return next
      })
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') void run()
  }

  return (
    <div className="terminal">
      <div className="terminal-body" ref={scrollRef}>
        {lines.length === 0 && (
          <div style={{ color: 'var(--text-faint)', fontSize: 12, padding: '4px 2px' }}>
            Run a command in the project. Use the active chat's shell.
          </div>
        )}
        {lines.map((line, i) => (
          <div key={i}>
            <div className="term-cmd">
              <span className="term-prompt">❯</span> {line.cmd}
            </div>
            <pre className="term-out">{line.out || '…'}</pre>
          </div>
        ))}
      </div>
      <div className="terminal-input-row">
        <span className="term-prompt">❯</span>
        <input
          ref={inputRef}
          value={input}
          placeholder={sessionID ? 'command…' : 'open a chat to run commands'}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={!sessionID}
          spellCheck={false}
        />
      </div>
    </div>
  )
}
