import { accessSync, constants, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

// PATH repair (see shell-path.ts) fixes the common case, but it cannot fix every case:
// a non-POSIX login shell (nushell, fish) defeats the probe, and no list of fallback
// directories covers every install layout. This is the escape hatch — the same one
// opencode already had through OPENCODE_BIN, extended to the other backends.
//
// Resolution order for a command:
//   0. OPENCODE_BIN, for opencode only: the name it had before the others existed
//   1. BOSS_<NAME>_BIN environment variable  (e.g. BOSS_CODEX_BIN=/opt/codex/bin/codex)
//   2. an absolute path recorded in settings  (Settings > Models & connections)
//   3. the bare command name, resolved through PATH
//
// An override that does not exist on disk is ignored rather than used, so a stale
// setting degrades to the PATH lookup instead of breaking a backend that would work.

type OverrideReader = () => Record<string, string | undefined>

let readOverrides: OverrideReader = () => ({})

/** Point the resolver at persisted settings. Called once during startup. */
export function setBinaryOverrideSource(reader: OverrideReader): void {
  readOverrides = reader
}

/**
 * The overrides the user has recorded, keyed by command name. Backed by a JSON file the
 * caller names during startup, so this module owns both halves of the rule — where an
 * override is stored and how it beats PATH — and nothing else has to know the format.
 */
export class BinaryOverrides {
  private cache: Record<string, string> | undefined
  // A plain field, not a constructor parameter property: the tests run under Node's
  // strip-only type stripping, which rejects that syntax.
  private readonly file: string

  constructor(file: string) {
    this.file = file
  }

  private load(): Record<string, string> {
    if (this.cache) return this.cache
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>
      this.cache = Object.fromEntries(
        Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      )
    } catch {
      // No file yet, or an unreadable one: every backend falls back to PATH.
      this.cache = {}
    }
    return this.cache
  }

  all(): Record<string, string> {
    return { ...this.load() }
  }

  /**
   * Record where a command lives, or clear it when the path is empty. Returns the full
   * set so the caller can render exactly what was stored.
   */
  set(command: string, path: string | undefined): Record<string, string> {
    const next = { ...this.load() }
    const trimmed = path?.trim()
    // An empty field means "use PATH", so clear rather than store a blank override.
    if (trimmed) next[command] = trimmed
    else delete next[command]
    this.cache = next
    try {
      writeFileSync(this.file, JSON.stringify(next, null, 2))
    } catch {
      /* Overrides keep working in memory if persistence is unavailable. */
    }
    return this.all()
  }
}

function envKey(command: string): string {
  return `BOSS_${command.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_BIN`
}

/** The environment variable to name in an error message, e.g. "set BOSS_CODEX_BIN". */
export function envHint(command: string): string {
  return `set ${envKey(command)}`
}

/**
 * Resolve the executable to spawn for a backend command. Returns the override when one
 * is configured and present on disk, otherwise the bare name for PATH to resolve.
 */
export function resolveBackendBin(command: string): string {
  const legacy = command === 'opencode' ? process.env.OPENCODE_BIN?.trim() : undefined
  // OPENCODE_BIN was always handed straight to spawn, so a bare name such as
  // `opencode-dev` resolved through PATH. Keep that: PATH resolves it for the
  // probe and the server alike.
  if (legacy && !legacy.includes('/') && !legacy.includes('\\')) return legacy
  const candidates = [legacy, process.env[envKey(command)], readOverrides()[command]]
  for (const candidate of candidates) {
    const trimmed = candidate?.trim()
    if (trimmed && existsSync(trimmed)) return trimmed
  }
  return command
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * The absolute path of the executable a backend command resolves to, or undefined when
 * there is none. A caller that hands the path to a library rather than to spawn needs
 * this: the Claude Agent SDK runs its own bundled binary unless it is given a real file,
 * and BOSS runs the user's installed CLI so a new model works the day it ships.
 */
export function findBackendExecutable(command: string, pathEnv = process.env.PATH ?? ''): string | undefined {
  const resolved = resolveBackendBin(command)
  if (isAbsolute(resolved)) return isExecutableFile(resolved) ? resolved : undefined
  const names = process.platform === 'win32' ? [`${resolved}.exe`, `${resolved}.cmd`, resolved] : [resolved]
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue
    for (const name of names) {
      const candidate = join(dir, name)
      if (isExecutableFile(candidate)) return candidate
    }
  }
  return undefined
}
