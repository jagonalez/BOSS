import { contextBridge, ipcRenderer } from 'electron'

/**
 * The whole API a plugin view gets. One method: call a tool on the plugin's own
 * MCP server.
 *
 * Everything a plugin needs — reading its data, writing it, computing anything —
 * goes through a tool it defined. That is the restriction that makes loading
 * prompt-generated HTML reasonable: the view has no filesystem, no network, no
 * Node, and no way to name another plugin. The plugin id is not a parameter
 * here; the main process reads it from the webview's own URL, so a view cannot
 * ask for someone else's tools by passing a different string.
 *
 * Sandboxed, so this file may only use contextBridge and ipcRenderer.
 */
contextBridge.exposeInMainWorld('bossPlugin', {
  call: (tool: string, args?: unknown): Promise<unknown> =>
    ipcRenderer.invoke('boss-plugin:call', { tool, args: args ?? {} })
})
