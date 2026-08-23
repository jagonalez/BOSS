/**
 * The type the window draws in.
 *
 * Conversation and terminal sizing are independent from the app chrome around them. They are
 * separate settings because they are read differently: prose is read continuously and wants to be
 * comfortable, while a terminal is scanned in columns and wants to fit.
 */

export interface FontOption {
  id: string
  label: string
  /** What goes into the CSS stack, ahead of the platform's own. */
  stack: string
}

/** The system's own faces, which is what the app uses until told otherwise. */
export const SYSTEM_UI_STACK = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
export const SYSTEM_MONO_STACK = "'SF Mono', ui-monospace, Menlo, Consolas, monospace"

/**
 * Faces the app offers by name. Nothing is bundled: each is either already on the machine or
 * falls through to the system stack behind it, which is why every entry keeps that fallback.
 */
export const UI_FONTS: FontOption[] = [
  { id: 'system', label: 'System', stack: SYSTEM_UI_STACK },
  { id: 'inter', label: 'Inter', stack: `Inter, ${SYSTEM_UI_STACK}` },
  { id: 'ibm-plex-sans', label: 'IBM Plex Sans', stack: `'IBM Plex Sans', ${SYSTEM_UI_STACK}` },
  { id: 'helvetica', label: 'Helvetica Neue', stack: `'Helvetica Neue', ${SYSTEM_UI_STACK}` }
]

export const MONO_FONTS: FontOption[] = [
  { id: 'system', label: 'System', stack: SYSTEM_MONO_STACK },
  { id: 'jetbrains-mono', label: 'JetBrains Mono', stack: `'JetBrains Mono', ${SYSTEM_MONO_STACK}` },
  { id: 'fira-code', label: 'Fira Code', stack: `'Fira Code', ${SYSTEM_MONO_STACK}` },
  { id: 'source-code-pro', label: 'Source Code Pro', stack: `'Source Code Pro', ${SYSTEM_MONO_STACK}` },
  { id: 'menlo', label: 'Menlo', stack: `Menlo, ${SYSTEM_MONO_STACK}` }
]

export interface SizeRange {
  min: number
  max: number
  default: number
}

/** The conversation. Wide enough to matter, bounded so the layout it sits in still works. */
export const READING_SIZE: SizeRange = { min: 12, max: 22, default: 14.5 }

/** The terminal, which is read in columns and so runs smaller. */
export const TERMINAL_SIZE: SizeRange = { min: 10, max: 20, default: 13 }

export interface TypographySettings {
  uiFont: string
  monoFont: string
  readingSize: number
  terminalSize: number
}

export const DEFAULT_TYPOGRAPHY: TypographySettings = {
  uiFont: 'system',
  monoFont: 'system',
  readingSize: READING_SIZE.default,
  terminalSize: TERMINAL_SIZE.default
}

export function clampSize(range: SizeRange, value: number): number {
  if (!Number.isFinite(value)) return range.default
  // Half a point is a real step at these sizes, so the rounding keeps it.
  const rounded = Math.round(value * 2) / 2
  return Math.min(range.max, Math.max(range.min, rounded))
}

/** The next size up or down. The ends hold rather than wrap — this is a scale, not a ring. */
export function stepSize(range: SizeRange, value: number, delta: number): number {
  return clampSize(range, clampSize(range, value) + delta)
}

function fontStack(options: FontOption[], id: string, fallback: string): string {
  return options.find((option) => option.id === id)?.stack ?? fallback
}

export function uiFontStack(id: string): string {
  return fontStack(UI_FONTS, id, SYSTEM_UI_STACK)
}

export function monoFontStack(id: string): string {
  return fontStack(MONO_FONTS, id, SYSTEM_MONO_STACK)
}

/**
 * Read a stored value back, keeping whatever still makes sense and defaulting the rest. A face the
 * app no longer offers falls back to the system's own rather than leaving the window unstyled.
 */
export function typographyOrDefault(value: unknown): TypographySettings {
  if (!value || typeof value !== 'object') return { ...DEFAULT_TYPOGRAPHY }
  const stored = value as Partial<Record<keyof TypographySettings, unknown>>
  const known = (options: FontOption[], id: unknown, fallback: string): string =>
    typeof id === 'string' && options.some((option) => option.id === id) ? id : fallback
  return {
    uiFont: known(UI_FONTS, stored.uiFont, DEFAULT_TYPOGRAPHY.uiFont),
    monoFont: known(MONO_FONTS, stored.monoFont, DEFAULT_TYPOGRAPHY.monoFont),
    readingSize: clampSize(READING_SIZE, Number(stored.readingSize ?? READING_SIZE.default)),
    terminalSize: clampSize(TERMINAL_SIZE, Number(stored.terminalSize ?? TERMINAL_SIZE.default))
  }
}

/** The custom properties a set of choices comes down to, applied to the document root. */
export function typographyTokens(settings: TypographySettings): Record<string, string> {
  return {
    '--font-ui': uiFontStack(settings.uiFont),
    '--font-mono': monoFontStack(settings.monoFont),
    '--type-reading': `${settings.readingSize}px`,
    '--type-terminal': `${settings.terminalSize}px`
  }
}
