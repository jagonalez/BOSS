import React, { useState } from 'react'
import type { ProjectFilePreview } from '@shared/opencode'
import { CodeView } from './CodeView'
import { MarkdownDocument } from '../lib/text'
import { CodeIcon, CopyIcon } from './icons'

/** One file, shown the way its type deserves.
 *
 *  Everything used to go through CodeView, so a PNG arrived as the UTF-8
 *  decoding of its bytes. The kind is decided in the main process, where the
 *  file actually is, and this only chooses a presentation for it. */
export function FilePreview({ preview }: { preview: ProjectFilePreview }): React.JSX.Element {
  // Markdown and HTML have a source view, because a file browser that can only
  // show a rendered README cannot show you what you are about to edit.
  const [source, setSource] = useState(false)
  const toggleable = preview.kind === 'text' && (preview.render === 'markdown' || preview.render === 'html')

  if (preview.kind === 'image') {
    return (
      <div className="file-preview file-preview-image">
        <PreviewHead preview={preview} />
        <div className="file-preview-canvas">
          <img src={preview.url} alt={preview.path} />
        </div>
      </div>
    )
  }

  if (preview.kind === 'pdf') {
    return (
      <div className="file-preview file-preview-pdf">
        <PreviewHead preview={preview} />
        {/* Electron's built-in PDF viewer. The scheme is in frame-src, and the
            bytes come back with their own locked-down CSP. */}
        <iframe className="file-preview-frame" src={preview.url} title={preview.path} />
      </div>
    )
  }

  if (preview.kind === 'binary' || preview.note) {
    return (
      <div className="file-preview">
        <PreviewHead preview={preview} />
        <div className="empty">
          <p>{preview.note ?? 'This file has no preview.'}</p>
        </div>
      </div>
    )
  }

  const text = preview.content ?? ''

  if (toggleable && !source) {
    return (
      <div className="file-preview">
        <PreviewHead preview={preview} onToggleSource={() => setSource(true)} sourceLabel="Source" />
        {preview.render === 'markdown' ? (
          <div className="file-preview-markdown">
            <MarkdownDocument text={text} />
          </div>
        ) : (
          // srcDoc, not the file scheme: a repository's HTML is untrusted, and
          // a sandboxed frame with no allow-scripts renders it without letting
          // it run or reach the network.
          <iframe className="file-preview-frame" sandbox="" srcDoc={text} title={preview.path} />
        )}
      </div>
    )
  }

  return (
    <div className="file-preview">
      {toggleable ? (
        <PreviewHead preview={preview} onToggleSource={() => setSource(false)} sourceLabel="Preview" />
      ) : null}
      <CodeView text={text} path={toggleable ? undefined : preview.path} />
    </div>
  )
}

/** Path plus the actions that make sense for a file you cannot edit here. */
function PreviewHead({
  preview,
  onToggleSource,
  sourceLabel
}: {
  preview: ProjectFilePreview
  onToggleSource?: () => void
  sourceLabel?: string
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    if (preview.content === undefined) return
    window.boss.clipboardWrite(preview.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }
  return (
    <div className="code-view-head">
      <span className="code-view-path" title={preview.path}>
        {preview.path}
      </span>
      <div className="code-view-actions">
        {onToggleSource ? (
          <button className="btn-ghost" onClick={onToggleSource}>
            {sourceLabel}
          </button>
        ) : null}
        <button className="btn-ghost" onClick={() => void window.boss.openInEditor(preview.absolute)} title="Open in editor">
          <CodeIcon size={14} /> Open
        </button>
        {preview.content !== undefined ? (
          <button className="btn-ghost" onClick={copy} title="Copy file contents">
            <CopyIcon size={14} /> {copied ? 'Copied' : 'Copy'}
          </button>
        ) : null}
      </div>
    </div>
  )
}
