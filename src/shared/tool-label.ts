/**
 * What a tool call is called in the transcript.
 *
 * A row headed by the tool's name says the same thing fifteen times in a row: "Bash", "Bash",
 * "Bash". The name is the least distinguishing part of a call — what the reader is looking for is
 * which command ran, or which file was read. So the argument leads, and the tool name is left to
 * the icon beside it.
 */

/**
 * The argument that identifies a call, in the order it is looked for.
 *
 * Order matters where a tool carries several of these: an agent spawn has both a description and a
 * prompt, and the description is the one written to be read.
 */
const IDENTIFYING_KEYS = [
  'command',
  'file_path',
  'filePath',
  // Ahead of `path`: a search carries both, and the pattern is what was searched for, while the
  // path is only where. Behind `path`, every grep would be named by its haystack.
  'pattern',
  'path',
  'query',
  'url',
  'description',
  'skill',
  'name',
  'prompt'
] as const

/** Beyond this a label stops being a label. A heredoc would otherwise fill the row. */
const MAX_LABEL = 120

/** Tools whose label reads better with a shell prompt in front of it. */
const SHELL_TOOLS = new Set(['bash', 'shell', 'bashoutput', 'killshell', 'run_terminal_cmd'])

/** Tools that search, where the pattern alone does not say where it was looked for. */
const SEARCH_TOOLS = new Set(['grep', 'glob', 'search', 'rg', 'ripgrep'])

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * The last two segments of a path, which is enough to tell two files apart without spending the
 * row on the part every path in the project shares.
 */
export function shortPath(value: string): string {
  const clean = value.replace(/\/+$/, '')
  const segments = clean.split('/').filter(Boolean)
  if (segments.length <= 2) return clean
  return `…/${segments.slice(-2).join('/')}`
}

/** Collapse the whitespace a multi-line argument carries, and cut it to a length a row can hold. */
function oneLine(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim()
  return collapsed.length > MAX_LABEL ? `${collapsed.slice(0, MAX_LABEL - 1)}…` : collapsed
}

/**
 * A label for one tool call, or undefined when its arguments say nothing worth reading — in which
 * case the caller keeps the tool's own name.
 */
export function toolLabel(tool: string | undefined, input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const args = input as Record<string, unknown>
  const name = (tool ?? '').toLowerCase()

  const command = text(args.command)
  if (command && SHELL_TOOLS.has(name)) return oneLine(`$ ${command}`)

  for (const key of IDENTIFYING_KEYS) {
    const value = text(args[key])
    if (!value) continue
    const isPath = key === 'file_path' || key === 'filePath' || key === 'path'
    const label = isPath ? shortPath(value) : oneLine(value)
    // Two greps for the same pattern are the same row until the haystack is named.
    if (SEARCH_TOOLS.has(name)) {
      const where = text(args.path) ?? text(args.glob)
      if (where && key !== 'path') return oneLine(`${label} in ${shortPath(where)}`)
    }
    return label
  }

  // A tool carrying exactly one string argument is named by it, whatever that argument is called.
  const strings = Object.values(args).filter((value): value is string => text(value) !== undefined)
  return strings.length === 1 ? oneLine(strings[0]) : undefined
}
