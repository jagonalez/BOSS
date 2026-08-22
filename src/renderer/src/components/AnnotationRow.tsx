/**
 * The pending annotations sitting above the composer.
 *
 * This is the only durable sign that a highlight is attached: the highlight in
 * the transcript can scroll out of view, so without a row here someone would
 * send a prompt carrying quotes they had forgotten about.
 */

import React from 'react'
import type { Annotation } from '@shared/annotations'

export function AnnotationRow({
  annotations,
  onRemove
}: {
  annotations: readonly Annotation[]
  onRemove: (id: string) => void
}): React.JSX.Element | null {
  if (annotations.length === 0) return null

  return (
    <div className="composer-annotations" aria-label="Annotations on this message">
      {annotations.map((annotation, index) => (
        <span key={annotation.id} className="annotation-pill" title={annotation.quote}>
          <span className="annotation-pill-index">{index + 1}</span>
          <span className="annotation-pill-quote">{annotation.quote}</span>
          {annotation.note ? <span className="annotation-pill-note">{annotation.note}</span> : null}
          <button
            className="annotation-pill-remove"
            onClick={() => onRemove(annotation.id)}
            aria-label={`Remove annotation ${index + 1}`}
            title="Remove annotation"
          >
            ×
          </button>
        </span>
      ))}
    </div>
  )
}
