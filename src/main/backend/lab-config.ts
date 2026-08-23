/** Env-driven configuration shared by every Lab transport (BOSS backend, CLI,
 *  a future ACP server). `LAB_BASE_URL` always points at the *v1* root: the
 *  client appends `/chat/completions` to it, so both a plain ollama URL
 *  (`http://localhost:11434/v1`) and a cloud endpoint work unchanged. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? process.cwd()
}

/** Load KEY=VALUE lines from a dotenv file into process.env, only for keys not
 *  already set — a shell export always wins over the file. Used by the CLI so
 *  an API key can live in ~/.lab/.env instead of the shell profile. */
export function loadDotEnv(file = join(homeDir(), '.lab', '.env')): void {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
    if (key && process.env[key] === undefined) process.env[key] = value
  }
}

export type LabProfile = 'local' | 'cloud' | 'go'

type EnvDefaults = Array<[string, string]>

/** Presets that make the "which tier am I on?" decision one flag. `go` is
 *  OpenCode Go's OpenAI-compatible endpoint (DeepSeek V4 Flash default). */
const PROFILE_DEFAULTS: Record<LabProfile, EnvDefaults> = {
  local: [
    ['LAB_TOOLS', 'core'],
    ['LAB_CONTEXT_CHARS', '12000'],
    ['LAB_MAX_TOOL_ITERATIONS', '32']
  ],
  cloud: [
    ['LAB_TOOLS', 'all'],
    ['LAB_CONTEXT_CHARS', '80000'],
    ['LAB_MAX_TOOL_ITERATIONS', '32']
  ],
  go: [
    ['LAB_TOOLS', 'all'],
    ['LAB_CONTEXT_CHARS', '80000'],
    ['LAB_MAX_TOOL_ITERATIONS', '32'],
    ['LAB_BASE_URL', 'https://opencode.ai/zen/go/v1'],
    ['LAB_MODEL', 'deepseek-v4-flash']
  ]
}

/** Apply a profile's defaults for any LAB_* key not already set. Unknown or
 *  missing profiles fall back to `cloud` so the default tier is the cheap,
 *  reliable one rather than a laptop model. */
export function applyProfilePresets(profile?: string): LabProfile {
  const name = profile ?? process.env.LAB_PROFILE?.trim()
  if (name && name in PROFILE_DEFAULTS) {
    for (const [key, value] of PROFILE_DEFAULTS[name as LabProfile]) {
      if (process.env[key] === undefined) process.env[key] = value
    }
    return name as LabProfile
  }
  for (const [key, value] of PROFILE_DEFAULTS.cloud) {
    if (process.env[key] === undefined) process.env[key] = value
  }
  return 'cloud'
}

export type LabToolSet = 'core' | 'all'

export interface LabEnvConfig {
  baseUrl: string
  apiKey?: string
  defaultModel: string
  contextChars: number
  maxToolIterations: number
  /** Which tool schemas to advertise to the model each turn. `core` is a
   *  fraction of the schemas (search + edit + bash), which cuts prefill on
   *  small local models dramatically. */
  tools: LabToolSet
}

export function envBaseUrl(): string {
  const url = process.env.LAB_BASE_URL?.trim()
  return url || 'http://localhost:11434/v1'
}

export function envDefaultModel(): string {
  return process.env.LAB_MODEL?.trim() || 'qwen2.5-coder:latest'
}

export function envApiKey(): string | undefined {
  return process.env.LAB_API_KEY?.trim() || undefined
}

/** Approximate character budget for the history sent to the model each turn.
 *  Generous enough for a coding conversation, small enough to keep prefill fast
 *  on a laptop model; raise it with LAB_CONTEXT_CHARS for cloud models with big
 *  windows. */
export function envContextChars(): number {
  const parsed = Number.parseInt(process.env.LAB_CONTEXT_CHARS ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 20_000
}

export function envToolSet(): LabToolSet {
  return process.env.LAB_TOOLS?.trim().toLowerCase() === 'core' ? 'core' : 'all'
}

/** Cap on tool-bearing model rounds per user message. Repeated-call detection
 *  catches obvious loops earlier; this is the final bound for less obvious
 *  cycles. After reaching it, the engine still asks for one tool-free reply. */
export function envMaxToolIterations(): number {
  const parsed = Number.parseInt(process.env.LAB_MAX_TOOL_ITERATIONS ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 32
}

export function configFromEnv(): LabEnvConfig {
  applyProfilePresets()
  return {
    baseUrl: envBaseUrl(),
    apiKey: envApiKey(),
    defaultModel: envDefaultModel(),
    contextChars: envContextChars(),
    maxToolIterations: envMaxToolIterations(),
    tools: envToolSet()
  }
}
