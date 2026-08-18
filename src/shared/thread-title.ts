/** Preferences for the title BOSS gives a new thread after its first prompt. */
export interface ThreadTitleSettings {
  /** Derive a compact title from the first text prompt. This never calls a model. */
  autoNameFromFirstPrompt: boolean
}

export const DEFAULT_THREAD_TITLE_SETTINGS: ThreadTitleSettings = {
  autoNameFromFirstPrompt: false
}

const UNTITLED_TITLE = /^untitled(?: (?:opencode|pi|codex|claude))? thread$/i

/** Produce a readable local title without spending tokens. */
export function titleFromFirstPrompt(currentTitle: string | undefined, parts: unknown[]): string | undefined {
  if (currentTitle && !UNTITLED_TITLE.test(currentTitle.trim())) return undefined

  const text = parts
    .flatMap((part) => {
      if (!part || typeof part !== 'object') return []
      const item = part as { type?: unknown; text?: unknown }
      return item.type === 'text' && typeof item.text === 'string' ? [item.text] : []
    })
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim()

  if (!text) return undefined
  const concise = text
    .replace(/^(?:please\s+)?(?:can|could|would)\s+you\s+/i, '')
    .replace(/^help\s+(?:me\s+)?(?:to\s+)?/i, '')
    .replace(/\?$/, '')
    .trim()
  if (!concise) return undefined
  if (concise.length <= 72) return concise
  const truncated = concise.slice(0, 72)
  const boundary = truncated.lastIndexOf(' ')
  return `${(boundary >= 24 ? truncated.slice(0, boundary) : truncated).trim()}…`
}
