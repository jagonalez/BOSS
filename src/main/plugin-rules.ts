import type { PluginManifest, PluginViewManifest } from '../shared/plugin'

/**
 * The rules a plugin directory has to satisfy before BOSS will load it.
 *
 * These live in src/main rather than src/shared because only the main process
 * enforces them: the renderer receives already-validated PluginView objects and
 * never parses a manifest. Keeping them here also keeps plugin-manager.ts
 * loadable under Node's type-stripping test runner, which resolves a
 * same-directory './plugin-rules.ts' but not a cross-directory specifier.
 */

/**
 * A plugin's tools are namespaced by its id so two plugins cannot collide, and
 * so the view bridge can prove a page is calling only its own server. Kept
 * distinct from MCP_TOOL_PREFIX: a plugin is not a connection the user pasted
 * in, and deleting the plugin directory takes its tools with it.
 */
export const PLUGIN_TOOL_PREFIX = 'plugin_'

export function pluginToolName(pluginId: string, tool: string): string {
  return `${PLUGIN_TOOL_PREFIX}${pluginId}_${tool}`
}

/** Reject ids that would escape the plugins directory or break tool names. */
export function validPluginId(id: string): boolean {
  return /^[a-z][a-z0-9-]{1,39}$/.test(id)
}

/** A view id has to survive being put in a tab id and a URL. */
export function validViewId(id: string): boolean {
  return /^[a-z][a-z0-9-]{0,39}$/.test(id)
}

/**
 * Parse and check an untrusted manifest. Returns the reason it is unusable
 * rather than throwing, because one bad plugin must not stop the others from
 * loading — the manager reports it and carries on.
 */
export function manifestProblem(value: unknown): string | null {
  if (!value || typeof value !== 'object') return 'plugin.json is not an object.'
  const manifest = value as Partial<PluginManifest>
  if (typeof manifest.id !== 'string' || !validPluginId(manifest.id)) {
    return 'plugin.json needs an "id" of lowercase letters, digits and dashes, starting with a letter.'
  }
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) return 'plugin.json needs a "name".'
  if (typeof manifest.version !== 'string' || !manifest.version.trim()) return 'plugin.json needs a "version".'
  if (manifest.server !== undefined) {
    if (typeof manifest.server !== 'object' || manifest.server === null) return '"server" must be an object.'
    if (typeof manifest.server.command !== 'string' || !manifest.server.command.trim()) {
      return '"server.command" must be a non-empty string.'
    }
    if (manifest.server.args !== undefined && !Array.isArray(manifest.server.args)) {
      return '"server.args" must be an array.'
    }
  }
  if (manifest.views !== undefined) {
    if (!Array.isArray(manifest.views)) return '"views" must be an array.'
    const seen = new Set<string>()
    for (const view of manifest.views) {
      if (!view || typeof view !== 'object') return 'each view must be an object.'
      const candidate = view as Partial<PluginViewManifest>
      if (typeof candidate.id !== 'string' || !validViewId(candidate.id)) {
        return 'each view needs an "id" of lowercase letters, digits and dashes.'
      }
      if (seen.has(candidate.id)) return `two views share the id "${candidate.id}".`
      seen.add(candidate.id)
      if (typeof candidate.title !== 'string' || !candidate.title.trim()) return `view "${candidate.id}" needs a "title".`
      if (typeof candidate.entry !== 'string' || !candidate.entry.trim()) return `view "${candidate.id}" needs an "entry".`
      // An entry escaping the plugin directory would let a plugin render any
      // file on disk inside a trusted-looking tab.
      if (candidate.entry.startsWith('/') || candidate.entry.includes('..')) {
        return `view "${candidate.id}" has an "entry" outside the plugin directory.`
      }
    }
  }
  return null
}
