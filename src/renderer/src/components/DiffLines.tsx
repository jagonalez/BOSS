import React from 'react'
import type { DiffLine } from '../lib/diff'
import { langForPath, highlightCode } from '../lib/highlight'

export function DiffLines({ lines, path }: { lines: DiffLine[]; path?: string }): React.JSX.Element {
  const lang = path ? langForPath(path) : undefined
  return (
    <div className="diff-view">
      {lines.map((line, i) => {
        const highlightable = lang && line.kind !== 'hunk'
        let content: React.ReactNode = line.text || ' '
        if (highlightable) {
          try {
            content = <code dangerouslySetInnerHTML={{ __html: highlightCode(line.text, path) }} />
          } catch {
            /* fall back to plain text */
          }
        }
        return (
          <div key={i} className={`diff-line ${line.kind}`}>
            <span className="ln">{line.newNo ?? line.oldNo ?? ''}</span>
            <span className="lc">{content}</span>
          </div>
        )
      })}
    </div>
  )
}
