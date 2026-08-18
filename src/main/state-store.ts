import { app } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { UpdateChannel } from '@shared/ipc'

interface BossState {
  projectPath?: string
  /** Projects the user has opened. BOSS owns this list; opencode only knows a
   *  directory once it has served a session there, so sourcing it from opencode
   *  hid freshly added projects and emptied the list when opencode was absent. */
  projects?: string[]
  /** Which releases to offer. Absent means stable: someone who never chose a
   *  channel should not be moved onto prereleases by an update. */
  updateChannel?: UpdateChannel
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

