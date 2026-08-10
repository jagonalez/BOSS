import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'

const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  pre: ({ children }) => <pre className="part code">{children}</pre>,
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

export function MessageText({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
