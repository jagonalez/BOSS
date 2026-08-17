import React, { useMemo, useRef, useState } from 'react'
import { highlightCode } from '../lib/highlight'
import { CodeIcon, CopyIcon } from './icons'

export function CodeView({ text, path }: { text: string; path?: string }): React.JSX.Element {
  const html = useMemo(() => highlightCode(text, path), [text, path])
  const lineCount = useMemo(() => text.split('\n').length, [text])
  const numbers = useMemo(() => Array.from({ length: lineCount }, (_, i) => i + 1).join('\n'), [lineCount])
  const gutterRef = useRef<HTMLDivElement>(null)
  const codeRef = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)

  const syncScroll = (): void => {
    if (gutterRef.current && codeRef.current) {
      gutterRef.current.scrollTop = codeRef.current.scrollTop
    }
  }

  const copy = (): void => {
    window.boss.clipboardWrite(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  return (
    <div className="code-view-wrap">
      {path ? (
        <div className="code-view-head">
          <span className="code-view-path" title={path}>
            {path}
          </span>
          <div className="code-view-actions">
            <button className="btn-ghost" onClick={() => void window.boss.openInEditor(path)} title="Open in editor">
              <CodeIcon size={14} /> Open
            </button>
            <button className="btn-ghost" onClick={() => void copy()} title="Copy file contents">
              <CopyIcon size={14} /> {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      ) : null}
      <div className="code-scroll">
        <div className="code-gutter" ref={gutterRef}>
          <pre>{numbers}</pre>
        </div>
        <pre className="code-view" ref={codeRef} onScroll={syncScroll}>
          <code dangerouslySetInnerHTML={{ __html: html }} />
        </pre>
      </div>
    </div>
  )
}
