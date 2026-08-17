import { ipcMain, protocol, session, type WebContents } from 'electron'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PluginManager } from './plugin-manager'

/**
 * Serves plugin views and brokers their one IPC call.
 *
 * A plugin view is not loaded over file://. It gets its own scheme,
 * boss-plugin://<pluginId>/<viewId>, for two reasons. The scheme carries the
 * plugin id in the origin, so the broker below reads it from the sender's URL
 * rather than trusting a value the page passed. And it means one plugin's page
 * cannot fetch another plugin's files by walking a relative path, because every
 * request comes back here to be resolved against that plugin's directory.
 */
export const PLUGIN_SCHEME = 'boss-plugin'
export const PLUGIN_PARTITION = 'persist:boss-plugin'

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
}

/**
 * Registered before app ready: a custom scheme has to be privileged to get a
 * normal origin, and without one the page counts as opaque, which blocks
 * fetch and localStorage inside the view.
 */
export function registerPluginScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PLUGIN_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
    }
  ])
}

/** A plugin view URL, one origin per plugin so pages cannot reach each other. */
export function pluginViewUrl(pluginId: string, viewId: string): string {
  return `${PLUGIN_SCHEME}://${pluginId}/${viewId}`
}

/** The plugin id a guest page belongs to, read from its own URL. */
function pluginIdOf(contents: WebContents): string | null {
  try {
    const url = new URL(contents.getURL())
    if (url.protocol !== `${PLUGIN_SCHEME}:`) return null
    return url.hostname || null
  } catch {
    return null
  }
}

export function installPluginViews(plugins: PluginManager): void {
  const pluginSession = session.fromPartition(PLUGIN_PARTITION)

  // No network for a plugin view. Its data comes from its own tools, so a
  // generated page that tries to phone home simply fails.
  pluginSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith(`${PLUGIN_SCHEME}://`) })
  })

  pluginSession.protocol.handle(PLUGIN_SCHEME, async (request) => {
    const url = new URL(request.url)
    const pluginId = url.hostname
    // The first path segment is the view id; anything after it is an asset the
    // view referenced. Both resolve inside the plugin directory only.
    const segments = url.pathname.split('/').filter(Boolean)
    const viewId = segments[0] ?? ''
    const entry = await plugins.viewEntry(pluginId, viewId)
    if (!entry) return new Response('Not found', { status: 404 })

    let target = entry
    if (segments.length > 1) {
      const asset = await plugins.assetPath(pluginId, segments.slice(1).join('/'))
      if (!asset) return new Response('Not found', { status: 404 })
      target = asset
    }

    try {
      const body = await readFile(target)
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: {
          'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
          // Inline script and style are how a one-file plugin view is written,
          // so they are allowed. Everything remote is not, which is the part
          // that matters for generated code.
          'content-security-policy':
            "default-src 'none'; script-src 'unsafe-inline' 'self'; style-src 'unsafe-inline' 'self'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'"
        }
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })

  // The only channel a plugin view can use. The plugin id comes from the
  // sender's URL, never from the message, so a view can reach its own tools
  // and nothing else.
  ipcMain.handle('boss-plugin:call', async (event, payload: { tool?: unknown; args?: unknown }) => {
    const pluginId = pluginIdOf(event.sender)
    if (!pluginId) throw new Error('Only a plugin view may call plugin tools.')
    const tool = typeof payload?.tool === 'string' ? payload.tool : ''
    if (!tool) throw new Error('Pass the name of a tool on this plugin.')
    const text = await plugins.callTool(pluginId, tool, payload?.args ?? {})
    // Tools answer in text, but a view almost always wants the object behind
    // it. Parsed here so every plugin does not repeat the same try/catch.
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  })
}

/** Absolute file URL of the plugin preload, for the webview attribute. */
export function pluginPreloadUrl(preloadPath: string): string {
  return pathToFileURL(preloadPath).toString()
}
