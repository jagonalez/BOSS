/**
 * Plugins are how BOSS grows a capability it did not ship with. A plugin is a
 * directory holding two halves: an MCP server that does the work, and an HTML
 * view that shows it. Both halves are ordinary files an agent can write, which
 * is the point — "build me a task system" ends with a directory on disk rather
 * than a change to this repository.
 *
 * The tool half needs nothing new: McpHub already spawns stdio servers,
 * namespaces their tools and tracks their status. What a plugin adds is the
 * view, and one rule about how the view gets its data — through its own MCP
 * tools, never directly. That single restriction is what makes a
 * prompt-generated plugin safe to load: the view holds no filesystem handle, no
 * network, and no path to another plugin.
 */

/** The plugin's own manifest, as authored on disk in plugin.json. */
export interface PluginManifest {
  /** Stable identifier, also the directory name. Lowercase, used in tool names. */
  id: string
  name: string
  version: string
  description?: string
  /** stdio server providing this plugin's tools. Omit for a view-only plugin. */
  server?: {
    /** Executable, resolved against the plugin directory when relative. */
    command: string
    args?: string[]
    /** Names of environment variables the plugin needs; values come from BOSS. */
    env?: Record<string, string>
  }
  /** Views this plugin contributes. Each becomes an openable tab. */
  views?: PluginViewManifest[]
}

export interface PluginViewManifest {
  id: string
  /** Tab title. */
  title: string
  /** HTML file relative to the plugin directory. */
  entry: string
}

export type PluginStatus = 'disabled' | 'loading' | 'ready' | 'error'

/** A loaded plugin plus live state, for the renderer. */
export interface PluginView {
  manifest: PluginManifest
  /** Absolute path to the plugin directory. */
  path: string
  enabled: boolean
  status: PluginStatus
  error?: string
  /** Namespaced tool names this plugin's server exposes, once connected. */
  tools: string[]
}

/**
 * The project a tool call is being made for. BOSS supplies this on every call —
 * from the agent and from a view alike — so a plugin that stores per project
 * cannot end up with the two disagreeing about which project they are in.
 *
 * A plugin is free to ignore it, and stays global if it does. `projectId` is
 * "global" when no project is open, so it is always safe to use as a directory
 * name.
 */
export interface PluginProject {
  /** Stable id derived from the git common directory, or "global". */
  projectId: string
  /** Absolute path of the project's main worktree. Empty when global. */
  projectPath: string
}

/** Result of the agent scaffolding a plugin. */
export interface PluginScaffold {
  id: string
  path: string
  files: string[]
}

// The rules that validate a manifest live in src/main/plugin-rules.ts. Only the
// main process parses a manifest; the renderer consumes PluginView objects that
// have already been checked.
