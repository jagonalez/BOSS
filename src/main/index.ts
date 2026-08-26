import { app, BrowserWindow, protocol, session, shell } from 'electron'
import { ImageStore, IMAGE_SCHEME } from './image-store'
import { ProjectFiles, FILE_SCHEME } from './project-files'
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
import { openProject, registerIpc, type IpcDeps } from './ipc'
import { openTargetMessage, openTargetProblem, parseOpenTarget } from './cli-open'
import { IpcChannels, type ProjectOpenedEvent } from '@shared/ipc'
import { loadState } from './state-store'
import { BackendManager } from './backend/manager'
import { createBackend } from './backend/factory'
import { ThreadBus } from './thread-bus'
import { WorktreeManager } from './worktree-manager'
import { NotificationRouter } from './notification-router'
import { AutomationHooks } from './automation-hooks'
import { AutomationManager } from './automation-manager'
import { EventBus } from './event-bus'
import { WorkflowStore } from './workflow-store'
import { WorkflowEngine } from './workflow-engine'
import { BossWorkflowHost } from './workflow-host'
import { githubDeliveryEvent } from '../shared/workflow-events'
import { randomUUID } from 'node:crypto'
import { ReportManager } from './report-manager'
import { LabAssistantManager } from './lab-assistant-manager'
import { inspectGitHubWorkflowRun, listGitHubPullRequests } from './lab-assistant-github'
import { TelegramBot } from './telegram-bot'
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
import { GitLabReviewProvider } from './gitlab-review-provider'
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
  { scheme: IMAGE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: false } },
  // Project files the viewer shows as pictures or PDFs. Same reasoning as the
  // image scheme: file: is refused under webSecurity, and a scheme of our own
  // keeps the reach to the project directory named in the URL.
  { scheme: FILE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: false } }
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
const projectFiles = new ProjectFiles()
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
  claude: createBackend('claude', { server, api, events }),
  lab: createBackend('lab', { server, api, events })
}, worktrees, backendAuth, transcripts)
backendMgr.attachBinaryOverrides(backendBins)
const threadBus = new ThreadBus(backendMgr)
backendMgr.attachImageStore(images)
backendMgr.attachThreadBus(threadBus)
// One router for every channel. Both the backend manager and automations feed
// it, so a thread event and an automation event reach the same places.
const notifications = new NotificationRouter()
notifications.onForeground(() => BrowserWindow.getAllWindows().some((window) => window.isFocused()))
backendMgr.attachNotifications(notifications)
const reports = new ReportManager(
  join(app.getPath('userData'), 'reports.json'),
  (snapshot) => backendMgr.emit({ type: 'reports.updated', properties: { snapshot } })
)
backendMgr.attachReports(reports)
threadBus.attachReports(reports)
const automations = new AutomationManager({
  stateFile: join(app.getPath('userData'), 'automations.json'),
  runsFile: join(app.getPath('userData'), 'automation-runs.json')
}, backendMgr, worktrees, reports)
backendMgr.attachAutomations(automations)
automations.attachNotifications(notifications)
const labAssistant = new LabAssistantManager(
  join(app.getPath('userData'), 'lab-assistant.json'),
  {
    threads: () => backendMgr.supervisionSnapshot().threads,
    messageAgent: async (threadId, message) => {
      await backendMgr.addFollowUp(threadId, message)
    },
    refreshPullRequests: (repository) => listGitHubPullRequests(repository),
    inspectWorkflowRun: (repository, runId, attempt) => inspectGitHubWorkflowRun(repository, runId, attempt),
    // The managed pipeline runs on the durable workflow engine; passing an
    // existing workflowId updates that task's pipeline instead of minting a
    // new one. Referenced before workflowEngine's declaration below, which is
    // safe because it is only called after startup completes.
    startTaskWorkflow: async (input) => {
      const definition = {
        name: input.name,
        projectPath: input.projectPath,
        script: input.script,
        triggers: [],
        overlapPolicy: 'skip' as const,
        ...(input.budget ? { budget: input.budget } : {})
      }
      const workflow = input.workflowId
        ? await workflowEngine.update(input.workflowId, definition)
        : await workflowEngine.create(definition, 'builtin', { enabled: false })
      const run = await workflowEngine.runNow(workflow.id)
      return { workflowId: workflow.id, runId: run.id }
    },
    emit: (snapshot) => backendMgr.emit({ type: 'assistant.updated', properties: { snapshot } }),
    notify: (event) => notifications.publish(event)
  }
)
backendMgr.attachAssistant(labAssistant)
backendMgr.onEvent((event) => {
  void labAssistant.observeBackendEvent(event)
})
// GitHub webhooks are delivered to a loopback endpoint; exposing it to the
// internet is the user's tunnel, exactly like the mobile page.
const automationHooks = new AutomationHooks({ deliver: (id, token, event, body) => automations.deliverWebhook(id, token, event, body) })
automations.setHookUrl((id, token) => automationHooks.buildUrl(id, token))
const telegram = new TelegramBot(
  join(app.getPath('userData'), 'telegram.json'),
  join(app.getPath('userData'), 'telegram-token.bin'),
  backendMgr
)
backendMgr.attachTelegram(telegram)
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
const computerUse = new ComputerUse(join(app.getPath('userData'), 'computer-use.json'))
let browse: BrowseManager | null = null
const qaTools = new QaTools(() => browse, computerUse)
threadBus.attachQaTools(qaTools)
const pty = new PTYManager(backendAuth)
const speech = new SpeechManager()
const sites = new SitesManager(() => backendMgr.currentProject || server.projectPath)
const updates = new UpdateChecker()
const reviews = new ReviewManager(join(app.getPath('userData'), 'review-comments.json'), [
  new GitHubReviewProvider(),
  new GitLabReviewProvider()
])
// A thread opens its own pull or merge request through the bus, so the forge is reached from here
// rather than from the sandbox the agent's own shell runs in.
threadBus.attachReviews(reviews)
// Durable workflows: the engine replays journaled scripts over the event bus;
// the host gives its steps real agent conversations, worktrees, notifications,
// and change requests.
const workflowHost = new BossWorkflowHost({ backends: backendMgr, worktrees, reviews, notifications })
const workflowStore = new WorkflowStore(
  join(app.getPath('userData'), 'workflows.json'),
  join(app.getPath('userData'), 'workflow-runs.json')
)
const workflowBus = new EventBus(join(app.getPath('userData'), 'workflow-subscriptions.json'))
const workflowEngine = new WorkflowEngine(workflowStore, workflowBus, workflowHost, {
  onSnapshot: (snapshot) => backendMgr.emit({ type: 'workflows.updated', properties: { snapshot } })
})
backendMgr.attachWorkflows(workflowEngine)
threadBus.attachWorkflowEngine(workflowEngine)
// Every authenticated GitHub delivery reaches both durable control planes:
// Lab Assistant's PR/CI observers and the workflow event bus.
automations.setWebhookObserver(async (delivery) => {
  const event = githubDeliveryEvent(delivery, randomUUID(), Date.now())
  if (event) await workflowBus.publish(event).catch(() => {})
  await labAssistant.observeGitHub(delivery)
})

let ipcReady = false

function ipcDeps(): IpcDeps {
  return { server, api, events, backends: backendMgr, browse: browse!, optional, computerUse, qaTools, pty, speech, sites, updates, reviews, projectFiles, takePendingCliOpen }
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

app.on('second-instance', (_event, argv, workingDirectory) => {
  // On macOS the app outlives its last window, so `boss` may reach an instance
  // with nothing on screen. Rebuild the window rather than opening a project
  // into a void — the same path 'activate' takes when the dock icon is clicked.
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    registerIpcOnce()
    loadRenderer()
  } else {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
  // `boss <folder>` run while BOSS is already up: the launch it started loses
  // the single-instance lock and quits, handing us its argv on the way out.
  // That is the whole mechanism — the command needs no port and no daemon.
  void openFromCli(parseOpenTarget(argv, workingDirectory))
})

/** Open a folder the `boss` command named, and tell the renderer to show it.
 *
 *  Goes through the same openProject as the in-app folder picker, which is what
 *  makes an unknown folder become a project: that function records any path it
 *  has not seen. Nothing here decides whether the folder is a project, because
 *  the answer is only ever "it is now". */
async function openFromCli(target: string | null): Promise<void> {
  if (!target) return
  const problem = openTargetProblem(target)
  if (problem) {
    sendProjectOpened({ project: null, created: false, problem: openTargetMessage(target, problem) })
    return
  }
  try {
    // Read the list before opening, since opening is what adds it: this is the
    // difference between "opened" and "added", and only knowable beforehand.
    const known = loadState().projects ?? []
    const project = await openProject(ipcDeps(), target)
    sendProjectOpened({ project, created: Boolean(project.path) && !known.includes(project.path) })
  } catch (error) {
    sendProjectOpened({
      project: null,
      created: false,
      problem: `BOSS could not open ${target}: ${error instanceof Error ? error.message : String(error)}`
    })
  }
}

/** The last `boss` result the renderer has not collected yet.
 *
 *  `boss <folder>` that starts the app resolves long before React mounts and
 *  subscribes, and a send with no listener is simply lost. Holding it here lets
 *  the renderer ask for it on mount, so the cold-start and already-running
 *  cases end in the same place instead of the first one silently doing nothing. */
let pendingCliOpen: ProjectOpenedEvent | null = null

function sendProjectOpened(event: ProjectOpenedEvent): void {
  // Held only while the page cannot have a listener yet. Once it is loaded the
  // push is delivery enough, and keeping a copy would open the project twice —
  // once now, once when the renderer collects on its next mount.
  const loaded = Boolean(mainWindow) && !mainWindow!.isDestroyed() && !mainWindow!.webContents.isLoading()
  pendingCliOpen = loaded ? null : event
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send(IpcChannels.ProjectOpened, event)
}

/** Hand over a result the renderer may have missed, and clear it. */
function takePendingCliOpen(): ProjectOpenedEvent | null {
  const event = pendingCliOpen
  pendingCliOpen = null
  return event
}

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(join(app.getAppPath(), 'resources', 'icons', '512x512.png'))
  }
  const isDev = Boolean(process.env.ELECTRON_RENDERER_URL)
  // Images a thread owns are served from disk under their own scheme, so
  // img-src has to admit it. Named rather than widened to file:, which would
  // let the renderer read anything on the machine.
  const img = `img-src 'self' data: ${IMAGE_SCHEME}: ${FILE_SCHEME}:;`
  // A PDF is shown in an <iframe> handed to Electron's built-in viewer, which
  // loads through the file scheme, so frame-src and object-src have to admit
  // it. Named rather than widened to file:, which would let the renderer frame
  // anything on the machine.
  const frame = `frame-src 'self' ${FILE_SCHEME}:; object-src 'self' ${FILE_SCHEME}:;`
  const csp = isDev
    ? `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws:; ${img} ${frame} media-src 'self' data: blob:; font-src 'self' data:;`
    : `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'; ${img} ${frame} media-src 'self' data: blob:; font-src 'self' data:;`
  // Answers only with a file inside the image directory; anything else is a
  // 404 rather than a read. The URL reaches here from the renderer, so the
  // store re-checks the resolved path rather than trusting it.
  protocol.handle(IMAGE_SCHEME, async (request) => {
    const found = images.read(request.url)
    if (!found) return new Response('Not found', { status: 404 })
    return new Response(found.data, { status: 200, headers: { 'Content-Type': found.mime } })
  })

  // Only image and PDF bytes are ever answered here, and only from inside the
  // project the URL names — source files go through IPC as text instead, so
  // this scheme cannot be turned into a general file read.
  protocol.handle(FILE_SCHEME, async (request) => {
    const found = projectFiles.read(request.url)
    if (!found) return new Response('Not found', { status: 404 })
    return new Response(found.data, {
      status: 200,
      headers: { 'Content-Type': found.mime, 'Content-Security-Policy': "default-src 'none'; object-src 'none'" }
    })
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
  // The daemon is process-bound, but the user's enable choice is not. Start a
  // fresh child for a choice remembered from the previous BOSS process.
  void computerUse.restore()
  loadRenderer()
  const saved = loadState()
  // `boss <folder>` that started the app, rather than handing off to a running
  // one. Its folder outranks the last-used project: it is what was just asked
  // for, and starting the backend on it avoids opening one project to
  // immediately switch away from it.
  const launchTarget = parseOpenTarget(process.argv, process.cwd())
  const cliProject = launchTarget && !openTargetProblem(launchTarget) ? launchTarget : null
  const initialProject = cliProject ?? saved.projectPath
  if (initialProject) server.setInitialCwd(initialProject)
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
    await backendMgr.start(initialProject)
    sites.bind(openCodeBackend)
    // After the backend is up, so the project it records is one it can serve.
    // Registering it is what turns a folder BOSS has never seen into a project.
    if (cliProject) await openFromCli(cliProject)
    await mcpHub.start()
    await labAssistant.start()
    await automations.start()
    await workflowEngine.start()
    await automationHooks.start()
    await telegram.start()
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
  workflowEngine.stop()
  workflowHost.stop()
  void automationHooks.stop()
  void telegram.stop()
  void mcpHub.stop()
  void backendMgr.stop()
  void computerUse.dispose()
  void sites.stop()
  speech.dispose()
})
