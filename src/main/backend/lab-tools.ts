import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { BackendModeId } from '@shared/backend'
import type { FileNode } from '@shared/opencode'

export interface LabToolFunction {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    }
  }
}

/** The tools the model may call. Open with read_file and bash so Lab can look
 *  around, then write_file and edit_file for changes. */
export const LAB_TOOL_DEFINITIONS: LabToolFunction[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file inside the project. Pass start_line/end_line to read a slice; without them the whole file is returned (capped). Line numbers are prefixed when a range is requested.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file, relative to the project root.' },
          start_line: { type: 'integer', description: 'First line (1-based) to return.' },
          end_line: { type: 'integer', description: 'Last line (inclusive) to return.' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search file contents in the project for a regular expression. Returns a JSON array of {file, line, content} matches. Skips build and dependency directories. Use this to find where something is defined or referenced.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regular expression to search for, e.g. "TODO" or "function foo".' },
          path: { type: 'string', description: 'Optional subdirectory to limit the search to, relative to the project root.' },
          case_insensitive: { type: 'boolean', description: 'Match without case (default false).' },
          max_results: { type: 'integer', description: 'Maximum matches to return (default 200).' }
        },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description: 'List project files matching a glob pattern such as "src/**/*.ts" or "*.md". Returns a JSON array of paths relative to the project root, capped at a few thousand.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern. Supports * (within a segment), ** (any depth), ?, and {a,b} alternatives.' },
          path: { type: 'string', description: 'Optional subdirectory to search under, relative to the project root.' },
          max_results: { type: 'integer', description: 'Maximum paths to return (default 2000).' }
        },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a file inside the project with the given content.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file, relative to the project root.' },
          content: { type: 'string', description: 'The full contents to write.' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Apply a targeted replacement inside a file. old_string must match exactly once unless replace_all is true; use write_file for whole-file rewrites.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file, relative to the project root.' },
          old_string: { type: 'string', description: 'Exactly the text to replace.' },
          new_string: { type: 'string', description: 'The text to put in its place.' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence of old_string.' }
        },
        required: ['path', 'old_string', 'new_string']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Run a shell command in the project directory. Capture stdout and stderr and the exit code. Timeout is 60 seconds.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run, e.g. "npm test" or "git status".' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'spawn_subagent',
      description: 'Start a sub-agent to handle a chunk of work and wait for it to finish. The sub-agent runs in the same project directory with the same tools, and runs automatically (no further permission prompts — the approval to spawn is the check). Give it a complete, self-contained instruction: it only sees your instruction, the project, and nothing else from this thread. Returns the sub-agent\'s final summary.',
      parameters: {
        type: 'object',
        properties: {
          instruction: { type: 'string', description: 'The task for the sub-agent, stated in full with any context it needs.' },
          title: { type: 'string', description: 'Short name, e.g. "write the parser tests".' },
          model: { type: 'string', description: 'Model for the sub-agent, e.g. a stronger one for work that writes code. Omit to use this thread\'s model.' }
        },
        required: ['instruction']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_subagents',
      description: 'List this thread\'s sub-agents and their status (idle/running/completed/error/aborted). Use it to see whether delegated work finished or failed.',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'wait_subagents',
      description: 'Wait for several sub-agents to finish and return their results together as JSON. Pass subagent_ids to wait for a specific set; with none it waits for every worker this thread spawned. Spawn background workers with spawn_subagent(wait=false) to fan out, then gather them here.',
      parameters: {
        type: 'object',
        properties: {
          subagent_ids: { type: 'array', items: { type: 'string' }, description: 'Optional ids to wait for; defaults to all of this thread\'s sub-agents.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'wait_subagent',
      description: 'Block until one of this thread\'s sub-agents finishes, then return its final summary. Use it to collect background sub-agents spawned with wait=false.',
      parameters: {
        type: 'object',
        properties: {
          subagent_id: { type: 'string', description: 'The id of the sub-agent to wait for.' }
        },
        required: ['subagent_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'abort_subagent',
      description: 'Stop a running sub-agent by its id. Useful when a delegated worker is going down a wrong path.',
      parameters: {
        type: 'object',
        properties: {
          subagent_id: { type: 'string', description: 'The id of the sub-agent to stop.' }
        },
        required: ['subagent_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_status',
      description: 'Show the git working-tree status as a JSON array of {path, index, worktree} entries. Use it to see what changed before planning a commit.',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_diff',
      description: 'Show the unstaged diff (or staged with cached=true) as text. Pass path to limit it to one file. Returns a stat summary followed by the patch.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Optional path to limit the diff to, relative to the project root.' },
          cached: { type: 'boolean', description: 'Show staged (index) changes instead of working-tree changes.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_log',
      description: 'Show recent commit history as a JSON array of {hash, author, date, subject}.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: 'How many commits to show (default 10).' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_commit',
      description: 'Create a commit with the given message. By default only staged changes are committed; pass all=true to commit working-tree changes too.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'The commit message.' },
          all: { type: 'boolean', description: 'Stage and commit all working-tree changes (git commit -a).' }
        },
        required: ['message']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'revert_file',
      description: 'Undo the most recent write_file or edit_file on a path by restoring the content that was captured before the change. Use it when an edit went the wrong way.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to restore, relative to the project root.' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'todos',
      description: 'Replace this task\'s todo list. You own this list: track plan steps, open questions, and progress here so the user can follow along.',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: 'The full new todo list.',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string', description: 'What this step is.' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'], description: 'State of the step.' }
              },
              required: ['content']
            }
          }
        },
        required: ['todos']
      }
    }
  }
]

/** The tools a model really needs to find its way and act. Advertising only
 *  these on every turn keeps the request small — a big win for prefill on
 *  small local models, at the cost of hiding git/todos/orchestration. */
export const CORE_TOOL_NAMES = new Set(['read_file', 'write_file', 'edit_file', 'bash', 'grep', 'glob'])

export const CORE_TOOL_DEFINITIONS: LabToolFunction[] = LAB_TOOL_DEFINITIONS.filter(
  (tool) => CORE_TOOL_NAMES.has(tool.function.name)
)

/** The assistant's tools. The assistant is a cheap always-on helper that routes
 *  work rather than doing it: it may look around and delegate, but every code
 *  change goes to a sub-agent on a stronger model. Leaving out write_file,
 *  edit_file, bash, and git_commit makes that a property of the tool set rather
 *  than something a small model has to be trusted to respect. */
export const ASSISTANT_TOOL_NAMES = new Set([
  'read_file',
  'grep',
  'glob',
  'git_status',
  'git_diff',
  'git_log',
  'todos',
  'spawn_subagent',
  'list_subagents',
  'wait_subagent',
  'wait_subagents',
  'abort_subagent'
])

export const ASSISTANT_TOOL_DEFINITIONS: LabToolFunction[] = LAB_TOOL_DEFINITIONS.filter(
  (tool) => ASSISTANT_TOOL_NAMES.has(tool.function.name)
)

/** Recover a tool name when a provider streams a call with an empty
 *  `function.name`: match the arguments against the unambiguous schema shapes.
 *  Some models (and proxies) drop the name but keep valid arguments. */
export function inferToolName(args: Record<string, unknown>): string | undefined {
  if ('command' in args) return 'bash'
  if ('instruction' in args) return 'spawn_subagent'
  if ('todos' in args) return 'todos'
  if ('content' in args && 'path' in args) return 'write_file'
  if ('old_string' in args && 'path' in args) return 'edit_file'
  if ('pattern' in args) {
    // A pattern with a glob wildcard is glob; otherwise the model meant grep.
    return String(args.pattern).includes('*') ? 'glob' : 'grep'
  }
  if ('path' in args) return 'read_file'
  if ('subagent_id' in args) return 'wait_subagent'
  return undefined
}

/** What a tool may touch. Drives the permission gate: reads always run,
 *  writes and shell need the user (or an approving mode). */
export type LabToolPermission = 'read' | 'write' | 'shell'

export function permissionForTool(name: string): LabToolPermission {
  switch (name) {
    case 'write_file':
    case 'edit_file':
    case 'git_commit':
    case 'revert_file':
      return 'write'
    case 'bash':
      return 'shell'
    // Launching (or stopping) a sub-agent is delegated work: it decides how to
    // spend the same project rights the parent has, so it is gated like a write.
    case 'spawn_subagent':
    case 'abort_subagent':
      return 'write'
    case 'read_file':
    case 'grep':
    case 'glob':
    case 'git_status':
    case 'git_diff':
    case 'git_log':
    case 'todos':
    case 'list_subagents':
    case 'wait_subagent':
    case 'wait_subagents':
      return 'read'
    default:
      return 'read'
  }
}

/** Directories never worth searching: dependencies, build output, and the
 *  agent's own scratch. */
const IGNORED_DIRECTORIES = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'bower_components', 'vendor',
  'dist', 'out', 'build', 'target', '.next', '.nuxt', '.output', '.svelte-kit',
  '.turbo', '.rollup.cache', '.cache', 'coverage', '.nyc_output',
  '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache',
  '.docusaurus', '.vscode', '.idea', '.mise', '.pnpm-store'
])

const MAX_FILE_SCAN_BYTES = 2 * 1024 * 1024

/** A directory tree walker honoring the ignore list. Returns absolute paths. */
export function walkFiles(root: string, ignore: ReadonlySet<string> = IGNORED_DIRECTORIES): string[] {
  const files: string[] = []
  const visit = (dir: string): void => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (ignore.has(entry.name)) continue
        visit(join(dir, entry.name))
      } else if (entry.isFile()) {
        files.push(join(dir, entry.name))
      }
    }
  }
  visit(root)
  return files
}

/** Compile a glob pattern to an anchored regular expression over `/`-separated
 *  relative paths. Supports `*` (within a segment), `**` (any depth), `?`,
 *  and `{a,b}` alternatives. */
export function globToRegExp(pattern: string): RegExp {
  let source = ''
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        i++
        if (pattern[i + 1] === '/') {
          i++
          source += '(?:.*/)?'
        } else {
          source += '.*'
        }
      } else {
        source += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      source += '[^/]'
      continue
    }
    if (char === '{') {
      const end = pattern.indexOf('}', i)
      if (end > i) {
        const alternatives = pattern.slice(i + 1, end).split(',').map((item) => item.trim())
        source += `(?:${alternatives.map((item) => escapeRegExp(item)).join('|')})`
        i = end
        continue
      }
    }
    source += escapeRegExp(char)
  }
  return new RegExp(`^${source}$`)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export interface GrepMatch {
  file: string
  line: number
  content: string
}

/** Search file contents under `root` (a file or a directory) for `pattern`.
 *  Results are capped at `max`, then the caller is told it was truncated. */
export function grepFiles(
  root: string,
  pattern: string,
  options: { path?: string; caseInsensitive?: boolean; max?: number } = {}
): { matches: GrepMatch[]; truncated: boolean } {
  const regex = new RegExp(pattern, options.caseInsensitive ? 'i' : '')
  const max = options.max ?? 200
  const base = options.path ? resolve(root, options.path) : root
  let files: string[]
  try {
    const stat = statSync(base)
    files = stat.isFile() ? [base] : walkFiles(base)
  } catch {
    return { matches: [], truncated: false }
  }
  const matches: GrepMatch[] = []
  for (const file of files) {
    if (matches.length >= max) break
    let stat: { size: number }
    try {
      stat = statSync(file)
    } catch {
      continue
    }
    if (stat.size > MAX_FILE_SCAN_BYTES) continue
    let content: string
    try {
      content = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (content.includes('\0')) continue
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= max) break
      const line = lines[i]
      if (regex.test(line)) {
        matches.push({ file: relative(root, file) || (options.path ?? file), line: i + 1, content: line.slice(0, 500) })
      }
    }
  }
  return { matches, truncated: matches.length >= max }
}

/** List files under `base` matching a glob pattern, as paths relative to
 *  `root`. */
export function globFiles(
  root: string,
  pattern: string,
  options: { path?: string; max?: number } = {}
): { files: string[]; truncated: boolean } {
  const regex = globToRegExp(pattern)
  const max = options.max ?? 2000
  const base = options.path ? resolve(root, options.path) : root
  let files: string[]
  try {
    const stat = statSync(base)
    files = stat.isFile() ? [base] : walkFiles(base)
  } catch {
    return { files: [], truncated: false }
  }
  const matched: string[] = []
  for (const file of files) {
    if (matched.length >= max) break
    const rel = relative(root, file)
    if (regex.test(rel)) matched.push(rel)
  }
  return { files: matched, truncated: matched.length >= max }
}

/** Slice `content` to a 1-based line range, prefixing each returned line with
 *  its number so the model can address it in edits. */
export function lineSlice(content: string, startLine: number, endLine?: number): string {
  const lines = content.split('\n')
  if (lines.at(-1) === '') lines.pop() // a file ending in a newline has no phantom last line
  const start = Math.max(1, startLine)
  const end = Math.min(endLine ?? lines.length, lines.length)
  if (start > end) throw new Error(`start_line ${start} is after end_line ${end}.`)
  return lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join('\n')
}

export interface GitCommandResult {
  stdout: string
  stderr: string
  code: number
}

/** Run git against the project checkout. A non-zero exit is returned, not
 *  thrown, so the model sees what git actually said. */
export function runGit(args: string[], cwd: string): Promise<GitCommandResult> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
      resolve({ stdout: String(stdout), stderr: String(stderr), code })
    })
  })
}

export interface GitStatusEntry {
  path: string
  index: string
  worktree: string
}

/** Parse `git status --porcelain` lines. Handles renames ("R  old -> new"). */
export function parseGitStatus(porcelain: string): GitStatusEntry[] {
  return porcelain
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const index = line[0] ?? '?'
      const worktree = line[1] ?? '?'
      const rawPath = line.slice(3)
      const arrow = rawPath.indexOf(' -> ')
      return { path: arrow >= 0 ? rawPath.slice(arrow + 4) : rawPath, index, worktree }
    })
}

export interface GitLogEntry {
  hash: string
  author: string
  date: string
  subject: string
}

/** Parse the `%H%x09%an%x09%ai%x09%s` format git is asked for. */
export function parseGitLog(formatted: string): GitLogEntry[] {
  return formatted
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [hash = '', author = '', date = '', ...rest] = line.split('\t')
      return { hash, author, date, subject: rest.join('\t') }
    })
}

export interface GitNumStatEntry {
  path: string
  additions: number
  deletions: number
}

/** Parse `git diff --numstat` output ("added\tdeleted\tpath"). Binary files
 *  report `-` in both columns. */
export function parseNumStat(text: string): GitNumStatEntry[] {
  return text.split('\n').filter(Boolean).map((line) => {
    const [added, deleted, ...rest] = line.split('\t')
    return {
      path: rest.join('\t'),
      additions: added === '-' ? 0 : Number(added) || 0,
      deletions: deleted === '-' ? 0 : Number(deleted) || 0
    }
  })
}

/** Build a nested file tree from absolute paths, with paths relative to the
 *  project root. `baseRel` scopes the result to one subdirectory. */
export function fileTreeFromPaths(projectAbs: string, files: string[]): FileNode[] {
  const roots: FileNode[] = []
  const byPath = new Map<string, FileNode>()
  const ensureDir = (rel: string): FileNode | undefined => {
    if (!rel) return undefined
    const existing = byPath.get(rel)
    if (existing) return existing
    const node: FileNode = { name: basename(rel), path: rel, type: 'directory', children: [] }
    byPath.set(rel, node)
    const parentRel = dirname(rel)
    if (parentRel === '.' || parentRel === rel) roots.push(node)
    else ensureDir(parentRel)?.children?.push(node)
    return node
  }
  for (const abs of files) {
    const rel = relative(projectAbs, abs)
    const parentRel = dirname(rel)
    const node: FileNode = { name: basename(rel), path: rel, type: 'file' }
    if (parentRel === '.' || parentRel === rel) roots.push(node)
    else ensureDir(parentRel)?.children?.push(node)
  }
  return roots
}

/** Pre-edit snapshots so the agent can undo a wrong write or edit with
 *  revert_file. Kept in memory for the lifetime of the engine; the first change
 *  to a path records its prior content, and revert restores and forgets it. */
export class FileSnapshots {
  private readonly snapshots = new Map<string, string>()

  /** Record the pre-change content of a path, unless one is already held. */
  capture(path: string, content: string): void {
    if (!this.snapshots.has(path)) this.snapshots.set(path, content)
  }

  snapshotFor(path: string): string | undefined {
    return this.snapshots.get(path)
  }

  /** Restore and forget the recorded snapshot. */
  revert(path: string): { had: boolean; content?: string } {
    const content = this.snapshots.get(path)
    if (content === undefined) return { had: false }
    this.snapshots.delete(path)
    return { had: true, content }
  }
}

/** What a tool may do, given the thread's permission mode. Reads always run;
 *  plan refuses; auto approves; accept-edits approves file edits but asks for
 *  shell; ask leaves every write and shell command to the user. */
export type ToolGateDecision = 'allow' | 'deny' | 'ask'

export function resolveToolGate(mode: BackendModeId, level: LabToolPermission): ToolGateDecision {
  if (level === 'read') return 'allow'
  if (mode === 'plan') return 'deny'
  if (mode === 'auto') return 'allow'
  if (mode === 'accept-edits' && level === 'write') return 'allow'
  return 'ask'
}

/** Whether a stored "always allow" grant lets a tool run without asking.
 *  Consulted only when the mode would otherwise ask. */
export function alwaysGrantsAllow(grants: string[] | undefined, toolName: string): boolean {
  return Boolean(grants?.includes(toolName))
}

/** Resolve a tool-supplied path against the project root, refusing escapes.
 *  The project check uses the text prefix so the path cannot jump out through
 *  symlinks or `..` components. */
export function resolveInCwd(cwd: string, rawPath: string): string {
  const resolved = isAbsolute(rawPath) ? resolve(rawPath) : resolve(cwd, rawPath)
  const root = resolve(cwd)
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error(`Path escapes the project: ${rawPath}`)
  }
  return resolved
}

/** Pure string-edit rule behind edit_file. Requires an exact single match
 *  unless replace_all is set, so an ambiguous edit fails loudly instead of
 *  changing the wrong spot. */
export function applyEdit(
  content: string,
  edit: { oldString: string; newString: string; replaceAll?: boolean }
): string {
  if (!edit.oldString) throw new Error('edit_file requires a non-empty old_string.')
  if (edit.replaceAll) {
    return content.split(edit.oldString).join(edit.newString)
  }
  const index = content.indexOf(edit.oldString)
  if (index < 0) throw new Error('old_string was not found in the file.')
  const second = content.indexOf(edit.oldString, index + edit.oldString.length)
  if (second >= 0) throw new Error('old_string matches more than once; set replace_all to replace every match.')
  return content.slice(0, index) + edit.newString + content.slice(index + edit.oldString.length)
}

export interface LabRunContext {
  /** Working directory for relative paths and shell commands. */
  cwd: string
  /** Cap on returned output characters. */
  maxOutputChars?: number
  /** Shell command timeout in milliseconds. */
  timeoutMs?: number
  /** Pre-edit snapshot store for revert_file. When absent, edits cannot be
   *  reverted (and none are captured). */
  snapshots?: FileSnapshots
}

export interface LabRunResult {
  output: string
  exitCode?: number
  truncated?: boolean
}

function cap(text: string, max: number, truncated: boolean): LabRunResult {
  const output = text.length > max ? text.slice(0, max) : text
  return { output, truncated: truncated || text.length > max }
}

/** Execute a tool by name. Never runs anything until the backend's permission
 *  gate has approved it — this function only does the work. */
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  context: LabRunContext
): Promise<LabRunResult> {
  const cwd = resolve(context.cwd)
  const max = context.maxOutputChars ?? 100_000
  const command = String(args.command ?? '')
  switch (name) {
    case 'read_file': {
      const path = String(args.path ?? '')
      if (!path) throw new Error('read_file requires a path.')
      const file = resolveInCwd(cwd, path)
      const content = readFileSync(file, 'utf8')
      const startLine = args.start_line != null ? Number(args.start_line) : NaN
      const endLine = args.end_line != null ? Number(args.end_line) : NaN
      if (Number.isFinite(startLine) || Number.isFinite(endLine)) {
        return { output: lineSlice(content, Number.isFinite(startLine) ? startLine : 1, Number.isFinite(endLine) ? endLine : undefined) }
      }
      return { output: content, truncated: content.length > max }
    }
    case 'grep': {
      const pattern = String(args.pattern ?? '')
      if (!pattern) throw new Error('grep requires a pattern.')
      const pathArg = String(args.path ?? '')
      const base = pathArg ? resolveInCwd(cwd, pathArg) : cwd
      const { matches, truncated } = grepFiles(cwd, pattern, {
        path: base,
        caseInsensitive: Boolean(args.case_insensitive),
        max: args.max_results != null ? Number(args.max_results) : undefined
      })
      const prefix = truncated ? `[truncated at ${matches.length} matches]\n` : ''
      return cap(prefix + JSON.stringify(matches, null, 2), max, truncated)
    }
    case 'glob': {
      const pattern = String(args.pattern ?? '')
      if (!pattern) throw new Error('glob requires a pattern.')
      const pathArg = String(args.path ?? '')
      const base = pathArg ? resolveInCwd(cwd, pathArg) : cwd
      const { files, truncated } = globFiles(cwd, pattern, {
        path: base,
        max: args.max_results != null ? Number(args.max_results) : undefined
      })
      const prefix = truncated ? `[truncated at ${files.length} paths]\n` : ''
      return cap(prefix + JSON.stringify(files, null, 2), max, truncated)
    }
    case 'git_status': {
      const result = await runGit(['status', '--porcelain'], cwd)
      if (result.code !== 0) return { output: `git status failed: ${result.stderr.trim() || `exit ${result.code}`}` }
      return cap(JSON.stringify(parseGitStatus(result.stdout), null, 2), max, false)
    }
    case 'git_diff': {
      const diffArgs = ['diff']
      if (Boolean(args.cached)) diffArgs.push('--cached')
      const pathArg = String(args.path ?? '')
      if (pathArg) diffArgs.push('--', resolveInCwd(cwd, pathArg))
      const patch = await runGit(diffArgs, cwd)
      if (patch.code !== 0) return { output: `git diff failed: ${patch.stderr.trim() || `exit ${patch.code}`}` }
      const stat = await runGit([...diffArgs, '--stat'], cwd)
      const output = `${stat.stdout.trim()}\n\n${patch.stdout}`.trim()
      return cap(output, max, patch.stdout.length > max)
    }
    case 'git_log': {
      const limit = args.limit != null ? Number(args.limit) : 10
      const result = await runGit(['log', '-n', String(limit), '--format=%H%x09%an%x09%ai%x09%s'], cwd)
      if (result.code !== 0) return { output: `git log failed: ${result.stderr.trim() || `exit ${result.code}`}` }
      return cap(JSON.stringify(parseGitLog(result.stdout), null, 2), max, false)
    }
    case 'git_commit': {
      const message = String(args.message ?? '')
      if (!message) throw new Error('git_commit requires a message.')
      const commitArgs = ['commit', '-m', message]
      if (Boolean(args.all)) commitArgs.push('-a')
      const result = await runGit(commitArgs, cwd)
      if (result.code !== 0) return { output: `git commit failed (${result.code}): ${result.stderr.trim()}` }
      return { output: (result.stdout || result.stderr).trim() }
    }
    case 'write_file': {
      const path = String(args.path ?? '')
      const content = String(args.content ?? '')
      if (!path) throw new Error('write_file requires a path.')
      const file = resolveInCwd(cwd, path)
      if (context.snapshots) {
        try {
          context.snapshots.capture(file, readFileSync(file, 'utf8'))
        } catch {
          /* new file: nothing to snapshot */
        }
      }
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, content)
      return { output: `Wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${relative(cwd, file) || path}. Use revert_file to undo.` }
    }
    case 'edit_file': {
      const path = String(args.path ?? '')
      if (!path) throw new Error('edit_file requires a path.')
      const file = resolveInCwd(cwd, path)
      const before = readFileSync(file, 'utf8')
      context.snapshots?.capture(file, before)
      const after = applyEdit(before, {
        oldString: String(args.old_string ?? ''),
        newString: String(args.new_string ?? ''),
        replaceAll: Boolean(args.replace_all)
      })
      writeFileSync(file, after)
      return { output: `Edited ${relative(cwd, file) || path}. Use revert_file to undo.` }
    }
    case 'revert_file': {
      const path = String(args.path ?? '')
      if (!path) throw new Error('revert_file requires a path.')
      const file = resolveInCwd(cwd, path)
      if (!context.snapshots) return { output: `No snapshot recorded for ${path}; nothing to revert.` }
      const { had, content } = context.snapshots.revert(file)
      if (!had || content === undefined) return { output: `No snapshot recorded for ${path}; nothing to revert.` }
      writeFileSync(file, content)
      return { output: `Reverted ${relative(cwd, file) || path} to its previous content.` }
    }
    case 'bash': {
      if (!command) throw new Error('bash requires a command.')
      const timeoutMs = context.timeoutMs ?? 60_000
      return runShell(command, cwd, timeoutMs, max)
    }
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

function runShell(command: string, cwd: string, timeoutMs: number, max: number): Promise<LabRunResult> {
  return new Promise((resolve) => {
    execFile(
      '/bin/sh',
      ['-c', command],
      { cwd, timeout: timeoutMs, maxBuffer: max * 4, env: process.env },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
        const timedOut = Boolean(error && error.killed && error.signal === 'SIGTERM')
        const combined = [stdout, stderr].filter(Boolean).join('\n').trim() || (timedOut ? 'Command timed out.' : '')
        resolve({ ...cap(combined, max, false), exitCode: timedOut ? 124 : code })
      }
    )
  })
}

/** Whether a path exists on disk. Handy for bash-friendly messaging. */
export function pathExists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}