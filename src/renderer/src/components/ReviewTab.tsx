import React from 'react'
import { GitView } from './GitView'

export function ReviewTab({ contextPath, sessionId }: { contextPath?: string; sessionId?: string }): React.JSX.Element {
  return (
    <div className="review">
      <GitView contextPath={contextPath} sessionId={sessionId} />
    </div>
  )
}
