import { app, BrowserWindow, session, shell } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
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
import { IpcChannels } from '@shared/ipc'
import { loadState } from './state-store'
import { BackendManager } from './backend/manager'
import { createBackend } from './backend/factory'
import { ThreadBus } from './thread-bus'
import { WorktreeManager } from './worktree-manager'
import { AutomationManager } from './automation-manager'
import { McpHub } from './mcp-hub'
import { WebAccess } from './web-access'
import { BackendAuth } from './backend-auth'
import { QaTools } from './qa-tools'
import { TranscriptStore } from './transcript-store'
import { UpdateChecker } from './updates'
import { ReviewManager } from './review-manager'
import { GitHubReviewProvider } from './github-review-provider'

const mainDir = dirname(fileURLToPath(import.meta.url))

// Dev runs get their own userData so a broken dev build cannot corrupt the
// installed app's workspaces, transcripts, and backend config. The suffix
// includes a hash of the checkout path, because the single-instance lock is
// keyed on userData: without it, a second clone of BOSS silently loses the
// lock to the first and exits. This must run before anything below reads
// app.getPath('userData').
if (process.env.ELECTRON_RENDERER_URL) {
  const checkout = createHash('sha256').update(app.getAppPath()).digest('hex').slice(0, 8)
  app.setPath('userData', `${app.getPath('userData')}-dev-${checkout}`)
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  // Exiting silently here looks identical to a crash. Say which profile is
  // already held, since a checkout elsewhere on disk claims the same lock.
  process.stderr.write(
    `[boss] another instance already owns ${app.getPath('userData')} — focusing it and exiting.\n`
  )
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
const webAccess = new WebAccess(join(app.getPath('userData'), 'mobile-access.json'), backendMgr)
backendMgr.attachMobile(webAccess)
webAccess.setOnChange(() => backendMgr.emit({ type: 'mobile.updated', properties: { status: webAccess.status() } }))

const optional = new OptionalDeps(process.env.BOSS_OPTIONAL_CDN)
const computerUse = new ComputerUse()
let browse: BrowseManager | null = null
const qaTools = new QaTools(() => browse, computerUse)
threadBus.attachQaTools(qaTools)
const pty = new PTYManager(backendAuth)
const speech = new SpeechManager()
const sites = new SitesManager(() => backendMgr.currentProject || server.projectPath)
const updates = new UpdateChecker()
const reviews = new ReviewManager(join(app.getPath('userData'), 'review-comments.json'), [
  new GitHubReviewProvider()
])

let ipcReady = false

function ipcDeps(): IpcDeps {
  return { server, api, events, backends: backendMgr, browse: browse!, optional, computerUse, pty, speech, sites, updates, reviews }
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
    if (process.env.BOSS_DEBUG) {
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
    await webAccess.start()
    // Runs last and unawaited: an update check must never delay startup.
    void updates.check().then((status) => {
      if (!status.available || !mainWindow || mainWindow.isDestroyed()) return
      mainWindow.webContents.send(IpcChannels.UpdateChanged, status)
    })
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
  void webAccess.stop()
  void automations.stop()
  void mcpHub.stop()
  void backendMgr.stop()
  void computerUse.dispose()
  void sites.stop()
  speech.dispose()
})
