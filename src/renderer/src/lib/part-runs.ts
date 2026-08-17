import type { Part } from '@shared/opencode'

export type PartRunKind = 'command' | 'page' | 'read' | 'edit' | 'other' | 'reasoning'

/** Kinds that fold into a single counted line.
 *
 *  Only calls that read. An edit or a command is the thing you audit or undo,
 *  so it keeps its own row and stays addressable. Every agent UI that groups
 *  tool calls draws the line in this same place. */
const COALESCING_KINDS = new Set<PartRunKind>(['read', 'page'])

export function coalesces(kind: PartRunKind): boolean {
  return COALESCING_KINDS.has(kind)
}

/** A run of neighbouring parts doing the same kind of work.
 *
 *  A long task can produce dozens of tool calls in a row. Listed flat they are
 *  one wall of near-identical rows, and whatever the agent said afterwards ends
 *  up far below it. A run collapses to a single line and opens when wanted. */
export interface PartRun {
  kind: PartRunKind
  parts: Array<{ part: Part; index: number }>
}

/** Whether a call carrying a file path actually wrote to it.
 *
 *  A path alone does not say: Read, Edit and Write all take one. The write is
 *  in the payload, so look for it there rather than trusting the tool name,
 *  which differs across backends. */
function writesToFile(input: Record<string, unknown>): boolean {
  return typeof input.content === 'string'
    || typeof input.new_string === 'string'
    || typeof input.newString === 'string'
    || typeof input.old_string === 'string'
    || typeof input.oldString === 'string'
    || Array.isArray(input.edits)
}

export function toolKind(part: Part): 'command' | 'page' | 'read' | 'edit' | 'other' {
  const input = part.state?.input as Record<string, unknown> | undefined
  if (input && typeof input.command === 'string') return 'command'
  if (input && typeof input.url === 'string') return 'page'
  if (input && (typeof input.file_path === 'string' || typeof input.filePath === 'string')) {
    return writesToFile(input) ? 'edit' : 'read'
  }
  return 'other'
}

/** Split a message's parts into runs, keeping the order they happened in.
 *
 *  The index travels with each part because keys need it: Claude emits
 *  tool_use and tool_result as separate parts sharing one id. */
export function groupPartRuns(parts: Part[]): PartRun[] {
  const runs: PartRun[] = []
  parts.forEach((part, index) => {
    const kind: PartRunKind | undefined = part.type === 'reasoning'
      ? (part.text ?? '').trim() ? 'reasoning' : undefined
      : part.type === 'tool' ? toolKind(part) : undefined
    if (!kind) return
    const last = runs[runs.length - 1]
    // Only reads fold. Reasoning explains the calls around it, and an edit or a
    // command is the thing you audit or undo — hiding either behind a count
    // buries what you came to look at.
    if (last && last.kind === kind && coalesces(kind)) last.parts.push({ part, index })
    else runs.push({ kind, parts: [{ part, index }] })
  })
  return runs
}

/** One piece of a turn, in the order it was streamed.
 *
 *  `narrative` is a part the reader reads directly — prose, or an image. It
 *  renders on its own. `steps` is a stretch of work between two of those. */
export type TurnSegment =
  | { type: 'narrative'; part: Part }
  | { type: 'steps'; parts: Part[] }

/** Whether a part is read as itself rather than as work that was done. */
function isNarrative(part: Part): boolean {
  if (part.type === 'text') return (part.text ?? part.state?.text ?? '').trim().length > 0
  // An image is the thing the reader looks at. Behind a collapsed card it is a
  // screenshot nobody sees.
  return part.type === 'file' && Boolean(part.state?.mime?.startsWith('image/') && part.state.url)
}

/** Split a turn into narrative and the work between it, keeping stream order.
 *
 *  The transcript used to render every tool call in one card and then all the
 *  prose beneath it, so the longer a turn ran the further its calls drifted
 *  from the sentence that explained them, and reading one meant scrolling past
 *  the whole card. A turn is really text, then work, then text: keeping that
 *  order puts each card under the line that introduced it. */
export function segmentTurn(parts: Part[]): TurnSegment[] {
  const segments: TurnSegment[] = []
  for (const part of parts) {
    if (isNarrative(part)) {
      segments.push({ type: 'narrative', part })
      continue
    }
    // Anything a StepCard would not draw is left out rather than opening a
    // segment it would render as empty.
    if (part.type !== 'tool' && part.type !== 'reasoning') continue
    if (part.type === 'reasoning' && !(part.text ?? '').trim()) continue
    const last = segments[segments.length - 1]
    if (last?.type === 'steps') last.parts.push(part)
    else segments.push({ type: 'steps', parts: [part] })
  }
  return segments
}
