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

export function unifiedDiff(original: string, content: string): DiffLine[] {
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

  let oldNo = 1
  let newNo = 1
  let lastChange: LineKind = 'ctx'
  const out: DiffLine[] = []
  for (const op of ops) {
    if (op.kind === 'eq') {
      out.push({ kind: 'ctx', oldNo, newNo, text: op.text })
      oldNo++
      newNo++
    } else if (op.kind === 'del') {
      if (lastChange === 'ctx' && out.length) {
        out.push({ kind: 'hunk', oldNo, newNo, text: '⋯' })
      }
      out.push({ kind: 'del', oldNo, newNo: null, text: op.text })
      oldNo++
      lastChange = 'del'
    } else {
      if (lastChange === 'ctx' && out.length) {
        out.push({ kind: 'hunk', oldNo, newNo, text: '⋯' })
      }
      out.push({ kind: 'add', oldNo: null, newNo, text: op.text })
      newNo++
      lastChange = 'add'
    }
  }
  return out
}
