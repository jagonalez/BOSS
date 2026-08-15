import type { Part } from '@shared/opencode'

export type PartRunKind = 'command' | 'page' | 'edit' | 'other' | 'reasoning'

/** A run of neighbouring parts doing the same kind of work.
 *
 *  A long task can produce dozens of tool calls in a row. Listed flat they are
 *  one wall of near-identical rows, and whatever the agent said afterwards ends
 *  up far below it. A run collapses to a single line and opens when wanted. */
export interface PartRun {
  kind: PartRunKind
  parts: Array<{ part: Part; index: number }>
}

export function toolKind(part: Part): 'command' | 'page' | 'edit' | 'other' {
  const input = part.state?.input as Record<string, unknown> | undefined
  if (input && typeof input.command === 'string') return 'command'
  if (input && typeof input.url === 'string') return 'page'
  if (input && (typeof input.file_path === 'string' || typeof input.filePath === 'string')) return 'edit'
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
    // Reasoning never joins a run: it explains the calls around it, and hiding
    // it behind a count would bury the one part written to be read.
    if (last && last.kind === kind && kind !== 'reasoning') last.parts.push({ part, index })
    else runs.push({ kind, parts: [{ part, index }] })
  })
  return runs
}
