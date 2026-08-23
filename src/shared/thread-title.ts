/** Preferences for the title BOSS gives a new thread after its first prompt. */
export interface ThreadTitleSettings {
  /** Derive a compact title from the first text prompt. This never calls a model. */
  autoNameFromFirstPrompt: boolean
}

export const DEFAULT_THREAD_TITLE_SETTINGS: ThreadTitleSettings = {
  autoNameFromFirstPrompt: false
}

const PLACEHOLDER_TITLE = /^(?:untitled(?: (?:opencode|pi|codex|claude))? thread|new session(?:\s*[-–—(].*)?|new (?:opencode|pi|codex|claude) thread)$/i

const ACTION_START = /^(?:add|allow|analy[sz]e|audit|build|change|check|configure|create|debug|deploy|design|diagnose|document|explain|find|fix|hide|implement|improve|integrate|investigate|make|migrate|optimi[sz]e|prevent|refactor|remove|rename|repair|replace|review|show|simplify|support|test|trace|update)\b/i
const REQUEST_PREFIX = /^(?:(?:hey|hi|hello)[,!:\s]+)?(?:please\s+|(?:(?:can|could|would|will)\s+you|(?:i|we)\s+(?:need|want|would like)\s+(?:you\s+)?to|help\s+(?:me|us)?\s*(?:to|with)?)\s+)/i
const GENERIC_OPENER = /^(?:(?:okay|ok|so|well|basically|actually)[,!:\s]+)+/i
const CONTEXT_ONLY = /^(?:for context|here(?:'s| is) (?:some |the )?(?:context|background)|some (?:context|background))\b/i
const OMIT_WORDS = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those',
  'i', 'me', 'my', 'we', 'us', 'our', 'you', 'your',
  'can', 'could', 'would', 'should', 'will', 'may', 'might',
  'is', 'are', 'am', 'be', 'being', 'been',
  'to', 'of', 'for', 'with', 'from', 'at', 'by', 'into',
  'please', 'just', 'really', 'very', 'need', 'want', 'help',
  'why', 'how', 'after', 'before', 'when'
])

function requestCandidates(text: string): string[] {
  return text
    .replace(/([.!?])\s+/g, '$1\n')
    .split(/\n+|\s+(?:—|–|--)\s+|\s+-\s+/)
    .map((candidate) => candidate
      .replace(/^\s*(?:>{1,3}\s*|#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)*/, '')
      .replace(GENERIC_OPENER, '')
      .replace(REQUEST_PREFIX, '')
      .replace(/\bno longer\b/gi, '')
      .trim()
      .replace(/^[,;:.!?\s]+|[,;:.!?\s]+$/g, ''))
    .filter(Boolean)
}

function labelFromCandidate(candidate: string): string | undefined {
  const words = candidate.split(/\s+/).filter((word) => {
    const plain = word.toLocaleLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    return plain && !OMIT_WORDS.has(plain)
  })
  const kept: string[] = []
  for (const word of words) {
    if (kept.length === 5) break
    const next = [...kept, word].join(' ')
    if (next.length > 48) break
    kept.push(word)
  }
  const label = kept.join(' ').replace(/[,;:.!?]+$/g, '').trim()
  if (!label) return undefined
  return `${label[0].toLocaleUpperCase()}${label.slice(1)}`
}

/** Whether an automatic title may still replace the backend's placeholder. */
export function canAutoNameThread(currentTitle: string | undefined): boolean {
  return !currentTitle || PLACEHOLDER_TITLE.test(currentTitle.trim())
}

/** Keep model output suitable for tabs, branches, and sidebar rows. */
export function normalizeGeneratedThreadTitle(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined
  let title = value.trim()
  try {
    const parsed = JSON.parse(title) as unknown
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>
      const field = record.title ?? record.name ?? record.answer
      if (typeof field === 'string') title = field
    } else if (typeof parsed === 'string') {
      title = parsed
    }
  } catch {
    // Plain text is a valid response too; normalization below handles it.
  }
  title = title
    .split(/\r?\n/, 1)[0]
    .replace(/^(?:thread\s+)?title\s*:\s*/i, '')
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/g, '')
    .trim()
  if (!title) return undefined
  if (title.length <= 48) return title
  const boundary = title.slice(0, 49).lastIndexOf(' ')
  return title.slice(0, boundary >= 20 ? boundary : 48).trim()
}

/** Produce a readable local title without spending tokens. */
export function titleFromFirstPrompt(currentTitle: string | undefined, parts: unknown[]): string | undefined {
  if (!canAutoNameThread(currentTitle)) return undefined

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
  const candidates = requestCandidates(text)
  const request = candidates.find((candidate) => ACTION_START.test(candidate))
    ?? candidates.find((candidate) => !CONTEXT_ONLY.test(candidate))
  return request ? labelFromCandidate(request) : undefined
}
