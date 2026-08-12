import { app, BrowserWindow, session, shell } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OpenCodeServer, resolveOpenCodeBin } from './opencode-server'
import { ApiClient } from './api-client'
import { EventStream } from './event-stream'
import { BrowseManager } from './browse'
import { OptionalDeps } from './optional-deps'
import { ComputerUse } from './computer-use'
import { PTYManager } from './pty-manager'
import { SpeechManager } from './speech'
import { SitesManager } from './sites'
import { registerIpc, type IpcDeps } from './ipc'
import { loadState } from './state-store'
import { BackendManager } from './backend/manager'
import { createBackend } from './backend/factory'
import { ThreadBus } from './thread-bus'
import { WorktreeManager } from './worktree-manager'
import { AutomationManager } from './automation-manager'
import { McpHub } from './mcp-hub'
import { BackendAuth } from './backend-auth'
import { QaTools } from './qa-tools'
import { TranscriptStore } from './transcript-store'

const mainDir = dirname(fileURLToPath(import.meta.url))

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

let mainWindow: BrowserWindow | null = null

const server = new OpenCodeServer()
const api = new ApiClient(server)
const events = new EventStream(server)
const openCodeBackend = createBackend('opencode', { server, api, events })
const backendAuth = new BackendAuth(resolveOpenCodeBin)
const worktrees = new WorktreeManager({
  stateFile: join(app.getPath('userData'), 'worktrees.json'),
  root: join(app.getPath('userData'), 'worktrees')
})
const transcripts = new TranscriptStore(join(app.getPath('userData'), 'transcripts.sqlite'))
const backendMgr = new BackendManager({
  opencode: openCodeBackend,
  pi: createBackend('pi', { server, api, events }),
  codex: createBackend('codex', { server, api, events }),
  claude: createBackend('claude', { server, api, events })
}, worktrees, backendAuth, transcripts)
const threadBus = new ThreadBus(backendMgr)
backendMgr.attachThreadBus(threadBus)
const automations = new AutomationManager({
  stateFile: join(app.getPath('userData'), 'automations.json'),
  runsFile: join(app.getPath('userData'), 'automation-runs.json')
}, backendMgr, worktrees)
backendMgr.attachAutomations(automations)
const mcpHub = new McpHub(join(app.getPath('userData'), 'mcp-connections.json'))
backendMgr.attachMcpHub(mcpHub)
threadBus.attachMcpHub(mcpHub)
mcpHub.setOnChange(() => {
  void mcpHub.list().then((connections) => backendMgr.emit({ type: 'mcp.updated', properties: { connections } })).catch(() => {})
})

const optional = new OptionalDeps(process.env.RALF_OPTIONAL_CDN)
const computerUse = new ComputerUse()
let browse: BrowseManager | null = null
const qaTools = new QaTools(() => browse, computerUse)
threadBus.attachQaTools(qaTools)
const pty = new PTYManager(backendAuth)
const speech = new SpeechManager()
const sites = new SitesManager(() => backendMgr.currentProject || server.projectPath)

let ipcReady = false

function ipcDeps(): IpcDeps {
  return { server, api, events, backends: backendMgr, browse: browse!, optional, computerUse, pty, speech, sites }
}

function registerIpcOnce(): void {
  if (ipcReady) return
  registerIpc(ipcDeps())
  ipcReady = true
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 16, y: 16 } } : {}),
    ...(process.platform === 'darwin' ? { vibrancy: 'menu' as const } : {}),
    acceptFirstMouse: process.platform === 'darwin',
    backgroundColor: process.platform === 'darwin' ? '#00000000' : '#0b0d10',
    icon: join(app.getAppPath(), 'resources', 'icons', '512x512.png'),
    webPreferences: {
      preload: join(mainDir, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false
    }
  })
  win.setMenuBarVisibility(false)

  win.webContents.on('console-message', (event) => {
    if (process.env.RALF_DEBUG) {
      process.stderr.write(`[renderer:${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})\n`)
    }
  })
  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    process.stderr.write(`[preload-error] ${preloadPath}: ${error.message}\n`)
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    process.stderr.write(`[renderer-gone] ${details.reason}\n`)
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  win.webContents.on('will-navigate', (event, url) => {
    const allowed = devUrl ? url.startsWith(devUrl) : url.startsWith('file://')
    if (!allowed) event.preventDefault()
  })

  mainWindow = win
  browse = new BrowseManager(win)
}

function loadRenderer(): void {
  if (!mainWindow) return
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(join(mainDir, '../renderer/index.html'))
  }
}

app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
})

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(join(app.getAppPath(), 'resources', 'icons', '512x512.png'))
  }
  const isDev = Boolean(process.env.ELECTRON_RENDERER_URL)
  const csp = isDev
    ? "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws:; img-src 'self' data:; media-src 'self' data: blob:; font-src 'self' data:;"
    : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'; img-src 'self' data:; media-src 'self' data: blob:; font-src 'self' data:;"
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (details.responseHeaders) {
      details.responseHeaders['Content-Security-Policy'] = [csp]
    }
    callback({ responseHeaders: details.responseHeaders })
  })

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    if (permission === 'media' || permission === 'mediaKeySystem') {
      callback(true)
      return
    }
    callback(false)
  })

  createWindow()
  registerIpcOnce()
  loadRenderer()
  const saved = loadState()
  if (saved.projectPath) server.setInitialCwd(saved.projectPath)
  void (async () => {
    await sites.start()
    try {
      const connection = await threadBus.start()
      server.configureThreadBus(connection)
      backendMgr.configureThreadBus(connection)
    } catch (error) {
      process.stderr.write(`[thread-bus] ${error instanceof Error ? error.message : String(error)}\n`)
    }
    await backendMgr.start(saved.projectPath)
    sites.bind(openCodeBackend)
    await mcpHub.start()
    await automations.start()
  })()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
    registerIpcOnce()
    loadRenderer()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void automations.stop()
  void mcpHub.stop()
  void backendMgr.stop()
  void computerUse.dispose()
  void sites.stop()
  speech.dispose()
})
