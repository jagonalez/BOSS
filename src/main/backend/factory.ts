import type { Backend } from './backend'
import { OpenCodeBackend } from './opencode-backend'
import { PiBackend } from './pi-backend'
import { CodexBackend } from './codex-backend'
import { ClaudeBackend } from './claude-backend'
import { LabBackend } from './lab-backend'
import type { BackendId } from '@shared/backend'
import type { OpenCodeServer } from '../opencode-server'
import type { ApiClient } from '../api-client'
import type { EventStream } from '../event-stream'

export function createOpenCodeBackend(server: OpenCodeServer, api: ApiClient, events: EventStream): Backend {
  return new OpenCodeBackend(server, api, events)
}

export function createPiBackend(cwd?: string): Backend {
  return new PiBackend(cwd)
}

export function createCodexBackend(cwd?: string): Backend {
  return new CodexBackend(cwd)
}

export function createClaudeBackend(cwd?: string): Backend {
  return new ClaudeBackend(cwd)
}

/** Lab needs no CLI or server: it talks to an OpenAI-compatible endpoint
 *  (local ollama by default) directly. */
export function createLabBackend(): Backend {
  return new LabBackend()
}

export function createBackend(engine: BackendId, deps: { server: OpenCodeServer; api: ApiClient; events: EventStream; cwd?: string }): Backend {
  switch (engine) {
    case 'opencode':
      return createOpenCodeBackend(deps.server, deps.api, deps.events)
    case 'pi':
      return createPiBackend(deps.cwd)
    case 'codex':
      return createCodexBackend(deps.cwd)
    case 'claude':
      return createClaudeBackend(deps.cwd)
    case 'lab':
      return createLabBackend()
    default:
      throw new Error(`Unsupported backend ${engine}`)
  }
}
