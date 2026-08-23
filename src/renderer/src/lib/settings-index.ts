/**
 * What lives in each settings section, so a name can be typed instead of guessed at.
 *
 * Nine sections and forty-odd settings is more than a sidebar of category names can answer for:
 * knowing that the terminal's start location is filed under "Git worktrees", or that the `boss`
 * command is under "Updates", means already knowing the answer. This is the index that makes
 * those findable, and it is written by hand on purpose — the sections are JSX, and a filter that
 * walked them would go stale the moment one was reworded without anyone noticing.
 *
 * Each entry names a setting a person might look for, the section that holds it, and the words
 * they might reach for that are not in its title.
 */

export type SettingsSectionId =
  | 'agents' | 'connections' | 'usage' | 'mcp' | 'mobile' | 'telegram'
  | 'collaboration' | 'worktrees' | 'appearance' | 'voice' | 'updates'

export interface SettingsEntry {
  /** What the setting is called where it lives. */
  label: string
  section: SettingsSectionId
  /** Words someone might search for that the label does not contain. */
  keywords?: string[]
}

export const SETTINGS_INDEX: SettingsEntry[] = [
  // Agent defaults
  { label: 'Default agent', section: 'agents', keywords: ['backend', 'claude', 'codex', 'opencode', 'pi', 'lab'] },
  { label: 'Permission mode', section: 'agents', keywords: ['auto', 'approve', 'ask', 'plan', 'confirm'] },
  { label: 'Auto-name threads', section: 'agents', keywords: ['title', 'rename', 'naming'] },
  { label: 'Agent network access', section: 'agents', keywords: ['sandbox', 'offline', 'curl', 'npm', 'gh'] },
  { label: 'Computer use', section: 'agents', keywords: ['qa', 'screenshot', 'automatic', 'accessibility'] },

  // Models & connections
  { label: 'Models and connections', section: 'connections', keywords: ['account', 'sign in', 'login', 'provider'] },
  { label: 'Runtime location', section: 'connections', keywords: ['binary', 'path', 'cli', 'executable', 'which'] },
  { label: 'Default model', section: 'connections', keywords: ['opus', 'sonnet', 'haiku', 'gpt', 'thinking'] },
  { label: 'Restart backend server', section: 'connections', keywords: ['reload', 'switch account'] },
  { label: 'Lab API connections', section: 'connections', keywords: ['openai', 'compatible', 'endpoint', 'base url'] },

  // Usage
  { label: 'Provider usage and balances', section: 'usage', keywords: ['quota', 'limit', 'plan', 'tokens', 'spend', 'rate limit', 'reset'] },

  // MCP
  { label: 'MCP connections', section: 'mcp', keywords: ['server', 'tools', 'stdio', 'http', 'import'] },
  { label: 'MCP secrets', section: 'mcp', keywords: ['token', 'header', 'authorization', 'keychain'] },

  // Mobile access
  { label: 'Mobile access', section: 'mobile', keywords: ['phone', 'remote', 'tailscale', 'ssh', 'tunnel'] },
  { label: 'Remote access relay', section: 'mobile', keywords: ['pair', 'qr', 'fly', 'relay url'] },
  { label: 'Access token', section: 'mobile', keywords: ['password', 'regenerate', 'sign out'] },
  { label: 'Read-only sharing token', section: 'mobile', keywords: ['viewer', 'share', 'review'] },
  { label: 'Paired devices', section: 'mobile', keywords: ['revoke', 'forget', 'unpair'] },
  { label: 'Push notifications', section: 'mobile', keywords: ['webhook', 'alert', 'away'] },

  // Telegram
  { label: 'Telegram inbox', section: 'telegram', keywords: ['bot', 'message', 'channel', 'chat', 'enable'] },
  { label: 'Bot token', section: 'telegram', keywords: ['botfather', 'keychain', 'api', 'forget'] },
  { label: 'Deliver into thread', section: 'telegram', keywords: ['steer', 'queue', 'destination'] },
  { label: 'Allowed chats', section: 'telegram', keywords: ['chat id', 'allowlist', 'who can write'] },

  // Collaboration
  { label: 'Thread collaboration', section: 'collaboration', keywords: ['thread bus', 'message', 'discover', 'agents talking'] },

  // Worktrees
  { label: 'Git worktrees', section: 'worktrees', keywords: ['branch', 'isolated', 'checkout'] },
  { label: 'Worktree location', section: 'worktrees', keywords: ['where', 'folder', 'app data', 'in project'] },
  { label: 'Worktree cleanup', section: 'worktrees', keywords: ['inactive', 'prune', 'remove', 'stale'] },
  { label: 'New terminal location', section: 'worktrees', keywords: ['terminal', 'cwd', 'start', 'shell', 'directory'] },

  // Appearance
  { label: 'Workspace layout', section: 'appearance', keywords: ['single', 'multi', 'thread', 'panes', 'split'] },
  { label: 'Theme', section: 'appearance', keywords: ['dark', 'light', 'colour', 'color', 'contrast', 'catppuccin', 'tokyo'] },
  { label: 'Interface font', section: 'appearance', keywords: ['typeface', 'family', 'ui', 'type'] },
  { label: 'Monospace font', section: 'appearance', keywords: ['code', 'terminal', 'mono', 'typeface', 'type'] },
  { label: 'Reading size', section: 'appearance', keywords: ['font size', 'bigger', 'smaller', 'text size', 'type'] },
  { label: 'Terminal size', section: 'appearance', keywords: ['font size', 'bigger', 'smaller', 'type'] },

  // Voice
  { label: 'Voice', section: 'voice', keywords: ['speech', 'tts', 'speak', 'read aloud'] },
  { label: 'Transcription', section: 'voice', keywords: ['dictation', 'microphone', 'asr', 'speech to text'] },

  // Updates
  { label: 'Update channel', section: 'updates', keywords: ['beta', 'stable', 'prerelease', 'version'] },
  { label: 'The boss command', section: 'updates', keywords: ['cli', 'install', 'terminal', 'shell', 'path', 'open'] }
]

export interface SettingsMatch extends SettingsEntry {
  section: SettingsSectionId
}

/**
 * Entries worth offering for what has been typed so far.
 *
 * Every word has to match something, so "terminal size" finds the size rather than everything
 * mentioning a terminal. A label match sorts ahead of a keyword one, since someone typing a word
 * that is in a title almost certainly means that setting.
 */
export function searchSettings(query: string): SettingsMatch[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  return SETTINGS_INDEX
    .map((entry) => {
      const label = entry.label.toLowerCase()
      const haystack = `${label} ${(entry.keywords ?? []).join(' ')}`
      if (!words.every((word) => haystack.includes(word))) return undefined
      return { entry, inLabel: words.every((word) => label.includes(word)) }
    })
    .filter((hit): hit is { entry: SettingsEntry; inLabel: boolean } => hit !== undefined)
    .sort((a, b) => Number(b.inLabel) - Number(a.inLabel))
    .map((hit) => hit.entry)
}
