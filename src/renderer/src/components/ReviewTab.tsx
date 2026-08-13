import React from 'react'
import { GitView } from './GitView'

export function ReviewTab({
  contextPath,
  sessionId,
  groupId,
  tabId
}: {
  contextPath?: string
  sessionId?: string
  groupId: string
  tabId: string
}): React.JSX.Element {
  return (
    <div className="review">
      <GitView contextPath={contextPath} sessionId={sessionId} groupId={groupId} reviewTabId={tabId} />
    </div>
  )
}
