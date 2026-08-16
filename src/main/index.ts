import { app, BrowserWindow, protocol, session, shell } from 'electron'
import { ImageStore, IMAGE_SCHEME } from './image-store'
import { buildAppMenu } from './menu'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OpenCodeServer, resolveOpenCodeBin } from './opencode-server'
import { ApiClient } from './api-client'
import { EventStream } from './event-stream'
import { BROWSE_PARTITION, BrowseManager } from './browse'
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
import { RelayClient } from './relay-client'
// `ws` rather than Node 22's global WebSocket: the client uses the Node-style
// .on() event API, and ws exposes ping/pong needed for the heartbeat.
import { WebSocket as NodeWebSocket } from 'ws'
import { BackendAuth } from './backend-auth'
import { QaTools } from './qa-tools'
import { TranscriptStore } from './transcript-store'
import { UpdateChecker } from './updates'
import { ReviewManager } from './review-manager'
import { GitHubReviewProvider } from './github-review-provider'
import { restoreShellPath } from './shell-path'
import { BinaryOverrides, setBinaryOverrideSource } from './backend-bin'

const mainDir = dirname(fileURLToPath(import.meta.url))
const e2e = process.env.BOSS_E2E === '1'

// Launched from Finder, the app inherits launchd's bare PATH and cannot see any
// backend CLI. Repair PATH before the managers below are constructed, since they
// probe and spawn those binaries at import time.
restoreShellPath()

// Launched from Finder, the app inherits launchd's bare PATH and cannot see any
// backend CLI. Repair PATH before the managers below are constructed, since they
// probe and spawn those binaries at import time.
restoreShellPath()

// Dev runs get their own userData so a broken dev build cannot corrupt the
// installed app's workspaces, transcripts, and backend config. Every checkout
// shares that one dev profile, so threads and settings follow you between
// clones. The single-instance lock is keyed on userData, so running two clones
// at once needs BOSS_PROFILE to separate them. This must run before anything
// below reads app.getPath('userData').
if (e2e && process.env.BOSS_E2E_USER_DATA) {
  // Playwright runs the real app, but never against the user's BOSS profile.
  // This also gives each test its own single-instance lock and localStorage.
  app.setPath('userData', process.env.BOSS_E2E_USER_DATA)
} else if (process.env.ELECTRON_RENDERER_URL) {
  const profile = process.env.BOSS_PROFILE?.trim()
  const suffix = profile ? `-dev-${profile.replace(/[^A-Za-z0-9_-]/g, '-')}` : '-dev'
  app.setPath('userData', `${app.getPath('userData')}${suffix}`)
}

// Before whenReady, which is the only time a scheme can be given privileges.
// Images a thread owns are served from disk rather than embedded in the
// transcript, and the renderer runs with webSecurity on, so file: is refused.
// A scheme of BOSS's own keeps the reach to one directory.
protocol.registerSchemesAsPrivileged([
  { scheme: IMAGE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: false } }
])

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  // Exiting silently here looks identical to a crash. Name the profile that is
  // taken, since another checkout on disk shares it.
  process.stderr.write(
    `[boss] another instance already owns ${app.getPath('userData')} — focusing it and exiting.\n` +
      '[boss] to run a second checkout at the same time, set BOSS_PROFILE=<name>.\n'
  )
  app.quit()
}

let mainWindow: BrowserWindow | null = null

// PATH repair covers the common Finder launch, but a non-POSIX login shell defeats the
// probe. These are the manual escape hatch, and they must be readable before the first
// spawn below. userData is final by this point — the dev-profile switch runs above.
const backendBins = new BinaryOverrides(join(app.getPath('userData'), 'backend-bins.json'))
setBinaryOverrideSource(() => backendBins.all())

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
const images = new ImageStore(join(app.getPath('userData'), 'attachments'))
const backendMgr = new BackendManager({
  opencode: openCodeBackend,
  pi: createBackend('pi', { server, api, events }),
  codex: createBackend('codex', { server, api, events }),
  claude: createBackend('claude', { server, api, events })
}, worktrees, backendAuth, transcripts)
backendMgr.attachBinaryOverrides(backendBins)
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
// Remote access dials out to the relay, so it needs no inbound port.
const relayClient = new RelayClient(
  join(app.getPath('userData'), 'remote-access.json'),
  backendMgr,
  (url) => new NodeWebSocket(url) as never
)
backendMgr.attachRemote(relayClient)
relayClient.setOnChange(() => backendMgr.emit({ type: 'remote.updated', properties: { status: relayClient.status() } }))

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
    // Renderer automation does not need to put a second BOSS window over the
    // user's desktop. Set BOSS_E2E_SHOW=1 when debugging a test interactively.
    show: !e2e || process.env.BOSS_E2E_SHOW === '1',
    icon: join(app.getAppPath(), 'resources', 'icons', '512x512.png'),
    webPreferences: {
      preload: join(mainDir, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Browser panes are <webview> elements: a DOM element the renderer can
      // place, clip and move like any other pane content. See browse.ts for
      // why they are not WebContentsViews. Every attachment is checked below.
      webviewTag: true
    }
  })
  // Hidden but reachable with Alt. The window has its own title bar and the
  // menu would sit awkwardly under it, but the shortcuts and items still work.
  // Not on macOS, where the menu lives in the system bar and this does nothing.
  if (process.platform !== 'darwin') {
    win.setMenuBarVisibility(false)
    win.autoHideMenuBar = true
  }

  // A guest page may only be what BOSS asks for: its own hardened partition,
  // no preload of its own, sandboxed, with node off. The renderer sets these
  // as attributes, so they are re-checked here where they cannot be forged.
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload
    webPreferences.sandbox = true
    webPreferences.contextIsolation = true
    webPreferences.nodeIntegration = false
    webPreferences.webSecurity = true
    if (params.partition !== BROWSE_PARTITION) event.preventDefault()
  })

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
  browse = new BrowseManager()
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
  // Images a thread owns are served from disk under their own scheme, so
  // img-src has to admit it. Named rather than widened to file:, which would
  // let the renderer read anything on the machine.
  const img = `img-src 'self' data: ${IMAGE_SCHEME}:;`
  const csp = isDev
    ? `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws:; ${img} media-src 'self' data: blob:; font-src 'self' data:;`
    : `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'; ${img} media-src 'self' data: blob:; font-src 'self' data:;`
  // Answers only with a file inside the image directory; anything else is a
  // 404 rather than a read. The URL reaches here from the renderer, so the
  // store re-checks the resolved path rather than trusting it.
  protocol.handle(IMAGE_SCHEME, async (request) => {
    const found = images.read(request.url)
    if (!found) return new Response('Not found', { status: 404 })
    return new Response(found.data, { status: 200, headers: { 'Content-Type': found.mime } })
  })

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

  buildAppMenu()
  createWindow()
  registerIpcOnce()
  loadRenderer()
  const saved = loadState()
  if (saved.projectPath) server.setInitialCwd(saved.projectPath)
  if (e2e) return
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
    await relayClient.start()
    // A download reports progress and completion long after the check that
    // started it returned, so those have to be pushed rather than awaited.
    updates.subscribe((status) => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      mainWindow.webContents.send(IpcChannels.UpdateChanged, status)
    })
    // Runs last and unawaited: an update check must never delay startup.
    void updates.check()
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
  void relayClient.stop()
  void automations.stop()
  void mcpHub.stop()
  void backendMgr.stop()
  void computerUse.dispose()
  void sites.stop()
  speech.dispose()
})
