import React, { useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'
import { CopyIcon } from '../components/icons'
import { highlightFence, langFromClassName, nodeText } from './highlight'

/** One fenced chat code block: theme-highlighted, with a hover copy button.
 *
 *  The raw string is what gets copied — never the highlight markup — and the
 *  single trailing newline every fence carries goes with it. Feedback lives on
 *  the button long enough to read before it reverts. */
function CodeBlock({ className, children }: { className?: string; children?: React.ReactNode }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const raw = useMemo(() => nodeText(children).replace(/\n$/, ''), [children])
  const html = useMemo(() => highlightFence(raw, langFromClassName(className)), [raw, className])

  const copy = (): void => {
    window.boss.clipboardWrite(raw)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="code-block">
      <pre className="part code">
        <code className={className} dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
      <button className={`code-copy ${copied ? 'copied' : ''}`} onClick={copy} title={copied ? 'Copied' : 'Copy code'}>
        <CopyIcon size={12} />
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

/** A markdown `pre`: a fenced block when there is real block content inside.
 *
 *  A fence always yields at least the closing newline of its content line, so
 *  a newline in the code text separates it from inline code, which cannot
 *  contain one. Anything else falls through to the plain renderer untouched. */
function Pre({ children }: { children?: React.ReactNode }): React.JSX.Element {
  const child = Array.isArray(children) ? children[0] : children
  const codeProps = React.isValidElement(child)
    ? (child.props as { className?: string; children?: React.ReactNode })
    : undefined
  if (codeProps && (codeProps.className?.includes('language-') || nodeText(codeProps.children).includes('\n'))) {
    return <CodeBlock className={codeProps.className}>{codeProps.children}</CodeBlock>
  }
  return <pre className="part code">{children}</pre>
}

const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  pre: Pre,
  code: (props) => {
    const { node, className, children } = props as { node?: { position?: { start: { line: number }; end: { line: number } } }; className?: string; children?: React.ReactNode }
    const isBlock = Boolean(className?.includes('language-')) || Boolean(node && node.position && node.position.start.line !== node.position.end.line)
    if (isBlock) {
      return <code className={className}>{children}</code>
    }
    return <code className="inline-code">{children}</code>
  },
  table: ({ children }) => (
    <div className="md-table">
      <table>{children}</table>
    </div>
  )
}

/**
 * Chat-style line breaks: agents write one item per line, but markdown folds
 * single newlines into spaces. Convert them to hard breaks (trailing two
 * spaces) outside fenced code blocks, where whitespace must stay untouched.
 */
function hardBreaks(text: string): string {
  return text
    .split(/(```[\s\S]*?(?:```|$))/)
    .map((segment) => segment.startsWith('```') ? segment : segment.replace(/([^\n])\n(?!\n)/g, '$1  \n'))
    .join('')
}

export function MessageText({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {hardBreaks(text)}
      </ReactMarkdown>
    </div>
  )
}

/**
 * A markdown *file*, rendered as its author wrote it.
 *
 * Deliberately not MessageText: hardBreaks() exists because agents write chat
 * prose where a single newline means a new line. In a committed .md, a single
 * newline is just a wrapped paragraph, and forcing breaks there would render
 * every README ragged. Same components, no chat rewriting.
 */
export function MarkdownDocument({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
