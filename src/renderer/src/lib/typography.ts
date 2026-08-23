import {
  DEFAULT_TYPOGRAPHY,
  READING_SIZE,
  TERMINAL_SIZE,
  stepSize,
  typographyOrDefault,
  typographyTokens,
  type TypographySettings
} from '@shared/typography'

const STORAGE_KEY = 'boss.typography'

/** Announced so a live surface that sizes itself in JS — the terminal — can follow along. */
export const TYPOGRAPHY_CHANGED = 'boss:typography-changed'

export function loadTypography(): TypographySettings {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    return typographyOrDefault(saved ? JSON.parse(saved) : undefined)
  } catch {
    // A corrupt or unreadable value is not worth failing a launch over.
    return { ...DEFAULT_TYPOGRAPHY }
  }
}

export function applyTypography(settings: TypographySettings): void {
  for (const [name, value] of Object.entries(typographyTokens(settings))) {
    document.documentElement.style.setProperty(name, value)
  }
  window.dispatchEvent(new CustomEvent(TYPOGRAPHY_CHANGED, { detail: settings }))
}

export function saveTypography(settings: TypographySettings): TypographySettings {
  const clean = typographyOrDefault(settings)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(clean))
  } catch {
    /* A full or blocked store still leaves the choice applied for this run. */
  }
  applyTypography(clean)
  return clean
}

/** Nudge one of the two sizes, for the menu commands that step them. */
export function stepReadingSize(delta: number): TypographySettings {
  const current = loadTypography()
  return saveTypography({ ...current, readingSize: stepSize(READING_SIZE, current.readingSize, delta) })
}

export function stepTerminalSize(delta: number): TypographySettings {
  const current = loadTypography()
  return saveTypography({ ...current, terminalSize: stepSize(TERMINAL_SIZE, current.terminalSize, delta) })
}
