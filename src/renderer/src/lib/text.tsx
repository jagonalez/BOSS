import React from 'react'

interface Segment {
  kind: 'text' | 'code'
  value: string
}

export function splitCode(text: string): Segment[] {
  const parts: Segment[] = []
  const re = /```([\w+-]*)\n?([\s\S]*?)```/g
  let last = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) parts.push({ kind: 'text', value: text.slice(last, match.index) })
    parts.push({ kind: 'code', value: match[2] })
    last = match.index + match[0].length
  }
  if (last < text.length) parts.push({ kind: 'text', value: text.slice(last) })
  if (parts.length === 0) parts.push({ kind: 'text', value: text })
  return parts
}

export function MessageText({ text }: { text: string }): React.JSX.Element {
  const parts = splitCode(text)
  return (
    <>
      {parts.map((part, i) =>
        part.kind === 'code' ? (
          <pre className="part code" key={i}>
            {part.value}
          </pre>
        ) : (
          <span className="part" key={i}>
            {part.value}
          </span>
        )
      )}
    </>
  )
}
