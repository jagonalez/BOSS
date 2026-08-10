import type { Backend } from './backend'
import { OpenCodeBackend } from './opencode-backend'
import { PiBackend } from './pi-backend'
import type { OpenCodeServer } from '../opencode-server'
import type { ApiClient } from '../api-client'
import type { EventStream } from '../event-stream'

export function createOpenCodeBackend(server: OpenCodeServer, api: ApiClient, events: EventStream): Backend {
  return new OpenCodeBackend(server, api, events)
}

export function createPiBackend(cwd?: string): Backend {
  return new PiBackend(cwd)
}

export type BackendEngine = 'opencode' | 'pi'

export function createBackend(engine: BackendEngine, deps: { server: OpenCodeServer; api: ApiClient; events: EventStream; cwd?: string }): Backend {
  switch (engine) {
    case 'opencode':
      return createOpenCodeBackend(deps.server, deps.api, deps.events)
    case 'pi':
      return createPiBackend(deps.cwd)
    default:
      throw new Error(`Unsupported backend ${engine}`)
  }
}
