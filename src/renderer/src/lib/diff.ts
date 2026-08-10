export type LineKind = 'ctx' | 'add' | 'del' | 'hunk'

export interface DiffLine {
  kind: LineKind
  oldNo: number | null
  newNo: number | null
  text: string
}

const MAX_LCS_LINES = 4000

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

export function parseGitStatusPorcelain(text: string): { branch: string; files: Array<{ path: string; staged: boolean; unstaged: boolean; untracked: boolean }> } {
  const files: Array<{ path: string; staged: boolean; unstaged: boolean; untracked: boolean }> = []
  let branch = ''
  for (const line of text.split('\n')) {
    if (!line) continue
    if (line.startsWith('##')) {
      const m = /##\s+(\S+)/.exec(line)
      if (m) branch = m[1].replace(/\.\.\./, '')
      continue
    }
    const xy = line.slice(0, 2)
    const path = line.slice(3)
    if (xy[0] === '?') {
      files.push({ path, staged: false, unstaged: false, untracked: true })
    } else {
      files.push({ path, staged: xy[0] !== ' ', unstaged: xy[1] !== ' ', untracked: false })
    }
  }
  return { branch, files }
}

export function unifiedDiff(original: string, content: string, context = 3): DiffLine[] {
  const a = original.split('\n')
  const b = content.split('\n')

  let ops: Array<{ kind: 'add' | 'del' | 'eq'; text: string }> = []

  if (a.length > MAX_LCS_LINES || b.length > MAX_LCS_LINES) {
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
