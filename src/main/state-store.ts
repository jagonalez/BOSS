import { app } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface BossState {
  projectPath?: string
}

function stateFile(): string {
  return join(app.getPath('userData'), 'state.json')
}

export function loadState(): BossState {
  try {
    return JSON.parse(readFileSync(stateFile(), 'utf8')) as BossState
  } catch {
    return {}
  }
}

export function saveState(patch: Partial<BossState>): void {
  const next = { ...loadState(), ...patch }
  try {
    writeFileSync(stateFile(), JSON.stringify(next, null, 2))
  } catch {
    /* ignore */
  }
}
