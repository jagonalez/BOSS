import React from 'react'
import type { DiffLine } from '../lib/diff'

export function DiffLines({ lines }: { lines: DiffLine[] }): React.JSX.Element {
  return (
    <div className="diff-view">
      {lines.map((line, i) => (
        <div key={i} className={`diff-line ${line.kind}`}>
          <span className="ln">{line.oldNo ?? ''}</span>
          <span className="ln">{line.newNo ?? ''}</span>
          <span>{line.text || ' '}</span>
        </div>
      ))}
    </div>
  )
}
