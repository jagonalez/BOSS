import { readFileSync, writeFileSync } from 'node:fs'

interface StoredComputerUseState {
  version: 1
  enabled: boolean
}

export function loadComputerUseEnabled(file: string): boolean {
  try {
    const stored: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!stored || typeof stored !== 'object') return false
    const candidate = stored as Partial<StoredComputerUseState>
    return candidate.version === 1 && candidate.enabled === true
  } catch {
    return false
  }
}

export function saveComputerUseEnabled(file: string, enabled: boolean): void {
  try {
    writeFileSync(file, JSON.stringify({ version: 1, enabled } satisfies StoredComputerUseState, null, 2))
  } catch {
    /* The live setting still applies if the preference cannot be written. */
  }
}
