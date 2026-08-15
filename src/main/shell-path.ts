import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

// A GUI app launched from Finder inherits launchd's environment (PATH is
// /usr/bin:/bin:/usr/sbin:/sbin), not the one your shell builds from .zshrc. Every
// backend CLI — claude, codex, pi, opencode — installs somewhere only the shell knows
// about (nvm, bun, ~/.local/bin, Homebrew), so without this the app spawns them, gets
// ENOENT, and reports every backend as "not installed" on a machine where they all work
// in a terminal. API keys exported from a shell profile go missing the same way.
//
// This is the same approach as VS Code's shellEnv service, GitHub Desktop, and the
// shell-env npm package: run the user's login shell and import what it prints. Two
// details are load-bearing, both from real setups that broke:
//
//  1. Interactive mode (-i) is required. A login-only shell reads .zprofile/.zshenv but
//     NOT .zshrc, which is where nvm/bun/opencode put their PATH edits.
//  2. The payload is wrapped in delimiters. Prompt frameworks (powerlevel10k, gitstatus)
//     write banners and errors to stdout at startup, so the output is not only our value.
//
// Non-POSIX shells (nushell, fish) reject or mangle `-ilc` — this is the documented
// failure mode of Codex's version of this fix. The probe is never trusted blindly: on
// failure we fall back to the known install directories below, so backends stay
// reachable. If that still misses a binary, OPENCODE_BIN and PATH set in the app's
// environment continue to win, since inherited values are kept ahead of the fallbacks.

const START = '__BOSS_ENV_START__'
const END = '__BOSS_ENV_END__'

/** Directories that hold agent CLIs but are rarely on a GUI app's PATH. */
function fallbackDirs(): string[] {
  const home = homedir()
  return [
    join(home, '.local', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.opencode', 'bin'),
    join(home, '.cargo', 'bin'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin'
  ]
}

/**
 * Variables we refuse to import. These describe the shell's own process, and copying
 * them into the app would misreport who we are or where we run.
 */
const BLOCKED = new Set(['PWD', 'OLDPWD', 'SHLVL', '_', 'TERM', 'TMPDIR'])

function probeLoginShell(shell: string): Record<string, string> | undefined {
  try {
    // `env -0` keeps values containing newlines intact.
    const raw = execFileSync(shell, ['-ilc', `printf '${START}'; env -0; printf '${END}'`], {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
      // A shell that tries to prompt must not hold the app's startup open.
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, TERM: 'dumb' }
    })
    const start = raw.indexOf(START)
    const end = raw.indexOf(END, start + START.length)
    if (start === -1 || end === -1) return undefined

    const parsed: Record<string, string> = {}
    for (const entry of raw.slice(start + START.length, end).split('\0')) {
      const eq = entry.indexOf('=')
      if (eq <= 0) continue
      parsed[entry.slice(0, eq)] = entry.slice(eq + 1)
    }
    return Object.keys(parsed).length ? parsed : undefined
  } catch {
    // Shell missing, non-POSIX (nushell), or too slow — the caller falls back.
    return undefined
  }
}

function dedupe(dirs: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const dir of dirs) {
    if (!dir || seen.has(dir)) continue
    seen.add(dir)
    out.push(dir)
  }
  return out
}

/**
 * Import the login shell's environment so every later spawn — backend probes, MCP stdio
 * servers, git, terminals — resolves the same binaries and credentials the user's
 * terminal does. Values already set in this process win, so anything the launcher passed
 * deliberately is preserved. Safe to call more than once. Returns the PATH now in effect.
 */
export function restoreShellPath(): string {
  if (process.platform === 'win32') return process.env.PATH ?? ''

  const shell = process.env.SHELL?.trim()
  const shellEnv = shell ? probeLoginShell(shell) : undefined

  if (shellEnv) {
    for (const [key, value] of Object.entries(shellEnv)) {
      if (key === 'PATH' || BLOCKED.has(key)) continue
      // Explicit values from the launcher outrank the shell profile.
      if (process.env[key] === undefined) process.env[key] = value
    }
  }

  // PATH merges rather than overwrites: inherited entries first so an explicit
  // launcher PATH keeps priority, then the shell's, then the known install dirs.
  process.env.PATH = dedupe([
    ...(process.env.PATH ?? '').split(delimiter),
    ...(shellEnv?.PATH ?? '').split(delimiter),
    ...fallbackDirs()
  ]).join(delimiter)

  return process.env.PATH
}
