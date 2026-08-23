export type LineKind = 'ctx' | 'add' | 'del' | 'hunk'

export interface DiffLine {
  kind: LineKind
  oldNo: number | null
  newNo: number | null
  text: string
}

const MAX_LCS_LINES = 4000
const MAX_LCS_CELLS = 1_000_000

/** One row of a side-by-side view. A row holds one side alone when its
 *  counterpart was inserted or deleted, and both when the sides align. Hunk
 *  markers span the whole row instead. */
export interface SplitRow {
  left: DiffLine | null
  right: DiffLine | null
  hunk?: string
}

function lcs(a: string[], b: string[]): number[][] {
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  return dp
}

function canBuildLcs(aLength: number, bLength: number): boolean {
  return (aLength + 1) * (bLength + 1) <= MAX_LCS_CELLS
}

export function parseGitDiff(text: string): DiffLine[] {
  const out: DiffLine[] = []
  let oldNo = 0
  let newNo = 0
  let inHunk = false
  for (const raw of text.split('\n')) {
    const line = raw
    if (line.startsWith('@@')) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      if (m) {
        oldNo = Number(m[1])
        newNo = Number(m[2])
      }
      out.push({ kind: 'hunk', oldNo, newNo, text: line })
      inHunk = true
      continue
    }
    if (!inHunk) continue
    if (line.startsWith('-') && !line.startsWith('---')) {
      out.push({ kind: 'del', oldNo: oldNo++, newNo: null, text: line.slice(1) })
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      out.push({ kind: 'add', oldNo: null, newNo: newNo++, text: line.slice(1) })
    } else {
      out.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text: line.startsWith(' ') ? line.slice(1) : line })
    }
  }
  return out
}

/** Collapse runs of whitespace so two lines that differ only in spacing
 *  compare equal. Trimmed at both ends: git's -w ignores leading and trailing
 *  space too. */
function squashWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

/** Split a line into word and non-word chunks. Keeping the separators as
 *  their own tokens means the segments rejoin into the original text exactly,
 *  which is what lets a word diff be drawn inline without losing punctuation
 *  or spacing. */
export function segmentWords(text: string): string[] {
  return text.match(/\w+|\s+|[^\w\s]+/g) ?? []
}

export type WordSegmentKind = 'eq' | 'add' | 'del'

export interface WordSegment {
  kind: WordSegmentKind
  text: string
}

/** Word-level LCS between an old and new line. Used to underline exactly what
 *  changed inside a modified pair instead of highlighting the whole line. */
export function wordSegments(oldText: string, newText: string): WordSegment[] {
  const a = segmentWords(oldText)
  const b = segmentWords(newText)
  if (!a.length || !b.length) {
    return [
      ...a.map((text) => ({ kind: 'del' as const, text })),
      ...b.map((text) => ({ kind: 'add' as const, text }))
    ]
  }
  // A generated/minified line can contain tens of thousands of tokens. The
  // full matrix would freeze or exhaust the renderer, so fall back to marking
  // the complete replacement when the fine-grained diff is too expensive.
  if (!canBuildLcs(a.length, b.length)) {
    return [
      { kind: 'del', text: oldText },
      { kind: 'add', text: newText }
    ]
  }
  const dp = lcs(a, b)
  const out: WordSegment[] = []
  const push = (kind: WordSegmentKind, text: string): void => {
    const last = out[out.length - 1]
    // Adjacent same-kind tokens merge, so rendering gets one span per change.
    if (last && last.kind === kind) last.text += text
    else out.push({ kind, text })
  }
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push('eq', a[i])
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push('del', a[i++])
    } else {
      push('add', b[j++])
    }
  }
  while (i < a.length) push('del', a[i++])
  while (j < b.length) push('add', b[j++])
  return out
}

/** Pair unified lines into rows of two for the side-by-side view. Context
 *  lines appear on both sides; a run of deletions is matched index-for-index
 *  against the run of additions that follows it, with leftovers keeping their
 *  own row so alignment with the other side is never faked. Hunk markers span
 *  both sides once. */
export function pairSplitLines(lines: DiffLine[]): SplitRow[] {
  const out: SplitRow[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.kind === 'ctx') {
      out.push({ left: line, right: line })
      i++
    } else if (line.kind === 'hunk') {
      out.push({ left: null, right: null, hunk: line.text })
      i++
    } else {
      const dels: DiffLine[] = []
      const delStart = i
      while (i < lines.length && lines[i].kind === 'del') i++
      const delEnd = i
      const adds: DiffLine[] = []
      while (i < lines.length && lines[i].kind === 'add') i++
      const addEnd = i
      for (let k = delStart; k < delEnd; k++) dels.push(lines[k])
      for (let k = delEnd; k < addEnd; k++) adds.push(lines[k])
      const paired = Math.min(dels.length, adds.length)
      for (let k = 0; k < paired; k++) out.push({ left: dels[k], right: adds[k] })
      for (let k = paired; k < dels.length; k++) out.push({ left: dels[k], right: null })
      for (let k = paired; k < adds.length; k++) out.push({ left: null, right: adds[k] })
    }
  }
  return out
}

/** Map each modified line to the line it was paired against — the k-th
 *  deletion in a changed block with the k-th addition that follows it. This
 *  is the same pairing the side-by-side view draws, reused so word-level
 *  marking agrees with what sits side by side on screen. */
export function pairModifiedCounterparts(lines: DiffLine[]): Map<number, number> {
  const pairs = new Map<number, number>()
  let i = 0
  while (i < lines.length) {
    if (lines[i].kind === 'del') {
      const delStart = i
      while (i < lines.length && lines[i].kind === 'del') i++
      const delEnd = i
      const addStart = i
      while (i < lines.length && lines[i].kind === 'add') i++
      const addEnd = i
      const paired = Math.min(delEnd - delStart, addEnd - addStart)
      for (let k = 0; k < paired; k++) {
        pairs.set(delStart + k, addStart + k)
        pairs.set(addStart + k, delStart + k)
      }
    } else i++
  }
  return pairs
}

/** Rewrite whitespace-only changes back into context. Runs over each block of
 *  consecutive deletions followed by additions, aligning them by squashed
 *  text; where the sides match they become one context line carrying both
 *  numbers. Real changes are left exactly as git reported them. */
export function ignoreWhitespaceChanges(lines: DiffLine[]): DiffLine[] {
  const out: DiffLine[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.kind !== 'del') {
      out.push(line)
      i++
      continue
    }
    const dels: DiffLine[] = []
    while (i < lines.length && lines[i].kind === 'del') dels.push(lines[i++])
    const adds: DiffLine[] = []
    while (i < lines.length && lines[i].kind === 'add') adds.push(lines[i++])
    // Walk both runs with an LCS on squashed text so interleaved real changes
    // survive in place rather than being swallowed by an equal-length guess.
    if (!canBuildLcs(dels.length, adds.length)) {
      out.push(...dels, ...adds)
      continue
    }
    const dp = lcs(dels.map((l) => squashWhitespace(l.text)), adds.map((l) => squashWhitespace(l.text)))
    let d = 0
    let a = 0
    while (d < dels.length && a < adds.length) {
      const same = dels[d].text === adds[a].text
      const wsOnly = !same && squashWhitespace(dels[d].text) === squashWhitespace(adds[a].text)
      if (dp[d + 1][a] >= dp[d][a + 1] && !same && !wsOnly) out.push(dels[d++])
      else if (same || wsOnly) {
        out.push({ kind: 'ctx', oldNo: dels[d].oldNo, newNo: adds[a].newNo, text: adds[a].text })
        d++
        a++
      } else out.push(adds[a++])
    }
    while (d < dels.length) out.push(dels[d++])
    while (a < adds.length) out.push(adds[a++])
  }
  return out
}

export function parseGitNameStatus(text: string): Array<{ path: string; status: string }> {
  const out: Array<{ path: string; status: string }> = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const m = /^(\S+)\t(.+)$/.exec(trimmed)
    if (m) out.push({ status: m[1], path: m[2].trim() })
  }
  return out
}

export function parseGitLog(text: string): Array<{ sha: string; msg: string }> {
  const out: Array<{ sha: string; msg: string }> = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const idx = line.indexOf(' ')
    if (idx > 0) out.push({ sha: line.slice(0, idx), msg: line.slice(idx + 1).trim() })
  }
  return out
}

export function parseGitBranches(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter(Boolean)
}

export interface StatusFile {
  path: string
  /** Renames arrive as `old -> new` in one entry; keeping the old path lets
   *  stage/unstage name both sides. */
  oldPath?: string
  staged: boolean
  unstaged: boolean
  untracked: boolean
}

function statusFile(xy: string, path: string, oldPath?: string): StatusFile {
  const file: StatusFile = {
    path,
    oldPath,
    staged: false,
    unstaged: false,
    untracked: false
  }
  if (xy[0] === '?') file.untracked = true
  else {
    file.staged = xy[0] !== ' '
    file.unstaged = xy[1] !== ' '
  }
  return file
}

export function parseGitStatusPorcelain(text: string): { branch: string; files: StatusFile[] } {
  const files: StatusFile[] = []
  let branch = ''
  if (text.includes('\0')) {
    const records = text.split('\0')
    for (let i = 0; i < records.length; i++) {
      const record = records[i]
      if (!record) continue
      const xy = record.slice(0, 2)
      const path = record.slice(3)
      // In porcelain v1 -z output, rename/copy records put the destination
      // first and the source in the following NUL-delimited field.
      const renamed = xy.includes('R') || xy.includes('C')
      const oldPath = renamed ? records[++i] : undefined
      files.push(statusFile(xy, path, oldPath))
    }
    return { branch, files }
  }
  for (const line of text.split('\n')) {
    if (!line) continue
    if (line.startsWith('##')) {
      const m = /##\s+(\S+)/.exec(line)
      if (m) branch = m[1].replace(/\.\.\./, '')
      continue
    }
    const xy = line.slice(0, 2)
    const raw = line.slice(3)
    // `git status --porcelain` writes a rename as `R  old -> new`; everything
    // else is a plain path. Quoted paths with spaces keep their quotes here —
    // git re-quotes them on the command line the same way.
    const arrow = raw.includes(' -> ') ? raw.split(' -> ') : null
    files.push(statusFile(xy, arrow ? arrow[1] : raw, arrow ? arrow[0] : undefined))
  }
  return { branch, files }
}

export function unifiedDiff(original: string, content: string, context = 3): DiffLine[] {
  const a = original.split('\n')
  const b = content.split('\n')

  let ops: Array<{ kind: 'add' | 'del' | 'eq'; text: string }> = []

  if (a.length > MAX_LCS_LINES || b.length > MAX_LCS_LINES || !canBuildLcs(a.length, b.length)) {
    for (const line of a) ops.push({ kind: 'del', text: line })
    for (const line of b) ops.push({ kind: 'add', text: line })
  } else {
    const dp = lcs(a, b)
    let i = 0
    let j = 0
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        ops.push({ kind: 'eq', text: a[i] })
        i++
        j++
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        ops.push({ kind: 'del', text: a[i] })
        i++
      } else {
        ops.push({ kind: 'add', text: b[j] })
        j++
      }
    }
    while (i < a.length) {
      ops.push({ kind: 'del', text: a[i] })
      i++
    }
    while (j < b.length) {
      ops.push({ kind: 'add', text: b[j] })
      j++
    }
  }

  const full = context >= ops.length
  const nextChange: number[] = new Array(ops.length)
  let nc = Infinity
  for (let i = ops.length - 1; i >= 0; i--) {
    nextChange[i] = nc
    if (ops[i].kind !== 'eq') nc = i
  }

  let oldNo = 1
  let newNo = 1
  let lastChange = -Infinity
  let skipping = false
  const out: DiffLine[] = []
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]
    if (op.kind === 'eq') {
      const near = full || i - lastChange <= context || nextChange[i] - i <= context
      if (near) {
        out.push({ kind: 'ctx', oldNo, newNo, text: op.text })
        skipping = false
      } else if (!skipping) {
        out.push({ kind: 'hunk', oldNo, newNo, text: '⋯' })
        skipping = true
      }
      oldNo++
      newNo++
    } else if (op.kind === 'del') {
      if (skipping && out[out.length - 1]?.kind !== 'hunk' && !full) {
        out.push({ kind: 'hunk', oldNo, newNo, text: '⋯' })
      }
      out.push({ kind: 'del', oldNo, newNo: null, text: op.text })
      oldNo++
      lastChange = i
      skipping = false
    } else {
      if (skipping && out[out.length - 1]?.kind !== 'hunk' && !full) {
        out.push({ kind: 'hunk', oldNo, newNo, text: '⋯' })
      }
      out.push({ kind: 'add', oldNo: null, newNo, text: op.text })
      newNo++
      lastChange = i
      skipping = false
    }
  }
  return out
}
