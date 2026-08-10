export function errorSummary(err: unknown): string {
  if (typeof err === 'string') return err
  if (err && typeof err === 'object') {
    const o = err as { name?: unknown; message?: unknown; data?: { message?: unknown; error?: { message?: unknown } } }
    const nested = o.data?.message ?? o.data?.error?.message
    const msg = typeof nested === 'string' && nested ? nested : typeof o.message === 'string' ? o.message : ''
    const name = typeof o.name === 'string' && o.name ? o.name : ''
    return [name, msg].filter(Boolean).join(': ') || JSON.stringify(o).slice(0, 200)
  }
  return String(err)
}

export function errorDetails(err: unknown): string {
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err, null, 2)
  } catch {
    return String(err)
  }
}
