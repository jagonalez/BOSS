import { app, BrowserWindow, session, shell } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OpenCodeServer } from './opencode-server'
import { ApiClient } from './api-client'
import { EventStream } from './event-stream'
import { BrowseManager } from './browse'
import { OptionalDeps } from './optional-deps'
import { ComputerUse } from './computer-use'
import { PTYManager } from './pty-manager'
import { SpeechManager } from './speech'
import { registerIpc, type IpcDeps } from './ipc'
import { loadState } from './state-store'
import { BackendManager } from './backend/manager'
import { createBackend } from './backend/factory'
import { ThreadBus } from './thread-bus'

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
const backendMgr = new BackendManager({
  opencode: openCodeBackend,
  pi: createBackend('pi', { server, api, events }),
  codex: createBackend('codex', { server, api, events }),
  claude: createBackend('claude', { server, api, events })
})
const threadBus = new ThreadBus(backendMgr)
backendMgr.attachThreadBus(threadBus)

const optional = new OptionalDeps(process.env.RALF_OPTIONAL_CDN)
const computerUse = new ComputerUse()
computerUse.bind(openCodeBackend)
const pty = new PTYManager()
const speech = new SpeechManager()

let browse: BrowseManager | null = null
let ipcReady = false

function ipcDeps(): IpcDeps {
  return { server, api, events, backends: backendMgr, browse: browse!, optional, computerUse, pty, speech }
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
    acceptFirstMouse: process.platform === 'darwin',
    backgroundColor: '#0b0d10',
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
  void threadBus.start()
    .then((connection) => {
      server.configureThreadBus(connection)
      return backendMgr.start(saved.projectPath)
    })
    .catch((error) => {
      process.stderr.write(`[thread-bus] ${error instanceof Error ? error.message : String(error)}\n`)
      return backendMgr.start(saved.projectPath)
    })
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
  void backendMgr.stop()
  void computerUse.dispose()
  speech.dispose()
})
