export interface ViewportAnchor {
  turnKey: string
  offsetFromViewportTop: number
}

/**
 * Pick a semantic boundary that remains observable when the virtualizer mounts
 * or unmounts a predecessor clipped above the viewport. The first boundary at
 * or below the reading line is stable across both slices; at the transcript
 * end, fall back to the closest boundary above it.
 */
export function selectViewportAnchor(candidates: ViewportAnchor[]): ViewportAnchor | undefined {
  let next: ViewportAnchor | undefined
  let previous: ViewportAnchor | undefined

  for (const candidate of candidates) {
    if (candidate.offsetFromViewportTop >= 0) {
      if (!next || candidate.offsetFromViewportTop < next.offsetFromViewportTop) next = candidate
    } else if (!previous || candidate.offsetFromViewportTop > previous.offsetFromViewportTop) {
      previous = candidate
    }
  }

  return next ?? previous
}

/** The relative scroll needed to put a rendered boundary back at its bookmark. */
export function viewportAnchorScrollDelta(currentOffset: number, bookmarkedOffset: number): number {
  return currentOffset - bookmarkedOffset
}
