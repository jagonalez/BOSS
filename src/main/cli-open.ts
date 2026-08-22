import { existsSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

/** Marks an argv entry as "the folder BOSS should open".
 *
 *  Electron hands `second-instance` the raw argv of the launch that lost the
 *  lock, and that argv is not ours alone: Chromium, the sandbox and macOS all
 *  add switches to it. A bare positional path would therefore be ambiguous
 *  with anything Electron chose to pass, so the shim names the folder with a
 *  flag no one else uses and we read only that. */
export const OPEN_FLAG = '--boss-open'

/** The folder named by a `boss` invocation, or null when it named none.
 *
 *  `cwd` is the shim's working directory, which is what makes `boss .` mean
 *  the terminal's folder rather than the running app's. A relative path is
 *  resolved against it for the same reason. */
export function parseOpenTarget(argv: readonly string[], cwd: string): string | null {
  const raw = flagValue(argv, OPEN_FLAG)
  if (raw === null) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(cwd, trimmed)
}

/** Reads `--flag value` and `--flag=value`, which callers use interchangeably. */
function flagValue(argv: readonly string[], flag: string): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index]
    if (entry === flag) return argv[index + 1] ?? null
    if (entry.startsWith(`${flag}=`)) return entry.slice(flag.length + 1)
  }
  return null
}

export type OpenTargetProblem = 'missing' | 'not-a-directory'

/** Why a path cannot be opened, or null when it can.
 *
 *  Checked in the main process rather than the shim because the shim may have
 *  handed the path to an app that is already running on another machine's
 *  behalf — and because a file path is a plausible typo for its folder. */
export function openTargetProblem(path: string): OpenTargetProblem | null {
  if (!existsSync(path)) return 'missing'
  try {
    if (!statSync(path).isDirectory()) return 'not-a-directory'
  } catch {
    return 'missing'
  }
  return null
}

export function openTargetMessage(path: string, problem: OpenTargetProblem): string {
  return problem === 'missing'
    ? `${path} does not exist, so BOSS did not open it.`
    : `${path} is a file, not a folder. BOSS opens projects, so pick the folder that contains it.`
}
