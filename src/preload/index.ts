import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IpcChannels,
  type ApiRequest
} from '../shared/ipc'
import type { BossApi } from '../shared/api'
import { installE2EApi } from './e2e'

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const boss: BossApi = {
  platform: () => process.platform,
  toggleMaximize: () => ipcRenderer.invoke(IpcChannels.WindowToggleMaximize),
  serverInfo: () => ipcRenderer.invoke(IpcChannels.ServerGetInfo),
  onServerStatusChanged: (cb) => subscribe(IpcChannels.ServerStatusChanged, cb),

  apiRequest: (req: ApiRequest) => ipcRenderer.invoke(IpcChannels.ApiRequest, req),

  subscribeEvents: () => ipcRenderer.invoke(IpcChannels.EventSubscribe),
  unsubscribeEvents: () => ipcRenderer.invoke(IpcChannels.EventUnsubscribe),
  onEvent: (cb) => subscribe(IpcChannels.EventData, cb),

  browseRegister: (id: string, webContentsId: number) => ipcRenderer.invoke(IpcChannels.BrowseRegister, { id, webContentsId }),
  browseUnregister: (id: string) => ipcRenderer.invoke(IpcChannels.BrowseUnregister, id),
  browseNavigate: (id: string, url: string) => ipcRenderer.invoke(IpcChannels.BrowseNavigate, { id, url }),
  browseBack: (id: string) => ipcRenderer.invoke(IpcChannels.BrowseGoBack, id),
  browseForward: (id: string) => ipcRenderer.invoke(IpcChannels.BrowseGoForward, id),
  browseReload: (id: string) => ipcRenderer.invoke(IpcChannels.BrowseReload, id),
  browseDestroy: (id: string) => ipcRenderer.invoke(IpcChannels.BrowseDestroy, id),
  onBrowseNavigation: (cb) => subscribe(IpcChannels.BrowseNavigation, cb),
  onBrowseAgentActivity: (cb) => subscribe(IpcChannels.BrowseAgentActivity, cb),
  onBrowseExternal: (cb) => subscribe(IpcChannels.BrowseExternal, cb),
  openExternal: (url: string) => ipcRenderer.invoke(IpcChannels.OpenExternal, url),
  openPath: (path: string) => ipcRenderer.invoke(IpcChannels.OpenPath, path),
  openInEditor: (path: string, line?: number) => ipcRenderer.invoke(IpcChannels.OpenInEditor, { path, line }),
  projectFileTree: (root: string, path?: string) => ipcRenderer.invoke(IpcChannels.ProjectFileTree, { root, path }),
  projectFilePreview: (root: string, path: string) => ipcRenderer.invoke(IpcChannels.ProjectFilePreview, { root, path }),

  optionalList: () => ipcRenderer.invoke(IpcChannels.OptionalList),
  optionalDownload: (id) => ipcRenderer.invoke(IpcChannels.OptionalDownload, id),
  onOptionalProgress: (cb) => subscribe(IpcChannels.OptionalProgress, cb),

  computerUseStatus: () => ipcRenderer.invoke(IpcChannels.ComputerUseStatus),
  setComputerUse: (on: boolean) => ipcRenderer.invoke(IpcChannels.ComputerUseSetEnabled, on),
  computerUsePermissions: () => ipcRenderer.invoke(IpcChannels.ComputerUsePermissions),
  requestComputerUsePermission: (pane: 'accessibility' | 'screenRecording') =>
    ipcRenderer.invoke(IpcChannels.ComputerUseRequestPermission, pane),
  openPrivacyPane: (pane: 'accessibility' | 'screenRecording') => ipcRenderer.invoke(IpcChannels.OpenPrivacyPane, pane),

  projectList: () => ipcRenderer.invoke(IpcChannels.ProjectList),
  projectForget: (path: string) => ipcRenderer.invoke(IpcChannels.ProjectForget, path),
  projectReorder: (paths: string[]) => ipcRenderer.invoke(IpcChannels.ProjectReorder, paths),
  projectCurrent: () => ipcRenderer.invoke(IpcChannels.ProjectCurrent),
  projectSet: (path: string) => ipcRenderer.invoke(IpcChannels.ProjectSet, path),
  projectChoose: () => ipcRenderer.invoke(IpcChannels.ProjectChoose),
  onProjectOpened: (cb) => subscribe(IpcChannels.ProjectOpened, cb),
  projectOpenedPending: () => ipcRenderer.invoke(IpcChannels.ProjectOpenedPending),

  cliStatus: () => ipcRenderer.invoke(IpcChannels.CliStatus),
  cliInstall: () => ipcRenderer.invoke(IpcChannels.CliInstall),
  cliUninstall: () => ipcRenderer.invoke(IpcChannels.CliUninstall),

  terminalCreate: (cwd?: string, cols?: number, rows?: number, authBackendId?: import('../shared/backend').BackendId) =>
    ipcRenderer.invoke(IpcChannels.TerminalCreate, { cwd, cols, rows, authBackendId }),
  terminalWrite: (id: string, data: string) => ipcRenderer.invoke(IpcChannels.TerminalWrite, { id, data }),
  terminalResize: (id: string, cols: number, rows: number) =>
    ipcRenderer.invoke(IpcChannels.TerminalResize, { id, cols, rows }),
  terminalDispose: (id: string) => ipcRenderer.invoke(IpcChannels.TerminalDispose, id),
  // send, not invoke: this fires for every batch the terminal draws, and waiting
  // for a reply each time would cost more than the flow control saves.
  terminalAck: (id: string, chars: number) => ipcRenderer.send(IpcChannels.TerminalAck, { id, chars }),
  terminalReady: (id: string) => ipcRenderer.send(IpcChannels.TerminalReady, id),

  // The clipboard lives in the main process. navigator.clipboard is behind a
  // permission the renderer is not granted, and Electron's own clipboard module
  // is not available to a sandboxed preload, so this is the one route left.
  // sendSync because the terminal reads the clipboard inside a keystroke
  // handler and has to have the text before that handler returns.
  clipboardRead: () => ipcRenderer.sendSync(IpcChannels.ClipboardRead) as string,
  clipboardWrite: (text: string) => ipcRenderer.send(IpcChannels.ClipboardWrite, text),
  onTerminalData: (cb) => subscribe(IpcChannels.TerminalData, cb),
  onTerminalExit: (cb) => subscribe(IpcChannels.TerminalExit, cb),
  gitRun: (path: string, args: string[]) => ipcRenderer.invoke(IpcChannels.GitRun, { path, args }),
  reviewSnapshot: (path: string) => ipcRenderer.invoke(IpcChannels.ReviewSnapshot, path),
  reviewChangeRequestDiff: (path: string) => ipcRenderer.invoke(IpcChannels.ReviewChangeRequestDiff, path),
  reviewLocalAdd: (path, input) => ipcRenderer.invoke(IpcChannels.ReviewLocalAdd, { path, input }),
  reviewLocalDelete: (path, commentId) => ipcRenderer.invoke(IpcChannels.ReviewLocalDelete, { path, commentId }),
  reviewPublishComment: (path, input) => ipcRenderer.invoke(IpcChannels.ReviewPublishComment, { path, input }),
  reviewReply: (path, commentId, body) => ipcRenderer.invoke(IpcChannels.ReviewReply, { path, commentId, body }),
  reviewSubmit: (path, event, body) => ipcRenderer.invoke(IpcChannels.ReviewSubmit, { path, event, body }),
  reviewCreateChangeRequest: (path, input) => ipcRenderer.invoke(IpcChannels.ReviewCreateChangeRequest, { path, input }),

  ttsStatus: () => ipcRenderer.invoke(IpcChannels.TtsStatus),
  ttsSpeak: (req) => ipcRenderer.invoke(IpcChannels.TtsSpeak, req),
  onSpeechStatusChanged: (cb) => subscribe(IpcChannels.SpeechStatusChanged, cb),

  asrTranscribe: (req) => ipcRenderer.invoke(IpcChannels.AsrTranscribe, req),

  backendRequest: (req) => ipcRenderer.invoke(IpcChannels.BackendRequest, req),

  // Main owns the graph file and validates every replace; the renderer only
  // ever sees the whole document or a typed refusal.
  productGraphGet: () => ipcRenderer.invoke(IpcChannels.ProductGraphGet),
  productGraphReplace: (graph) => ipcRenderer.invoke(IpcChannels.ProductGraphReplace, graph),

  sitesList: () => ipcRenderer.invoke(IpcChannels.SitesList),
  sitesPublish: (folder: string, name?: string) => ipcRenderer.invoke(IpcChannels.SitesPublish, { folder, name }),
  sitesRemove: (id: string) => ipcRenderer.invoke(IpcChannels.SitesRemove, id),
  sitesDeploy: (id: string) => ipcRenderer.invoke(IpcChannels.SitesDeploy, id),
  sitesUnpublish: (id: string) => ipcRenderer.invoke(IpcChannels.SitesUnpublish, id),
  sitesChooseFolder: () => ipcRenderer.invoke(IpcChannels.SitesChooseFolder),
  onSitesChanged: (cb) => subscribe(IpcChannels.SitesChanged, cb),
  sitesCfGet: () => ipcRenderer.invoke(IpcChannels.SitesCfGet),
  sitesCfSet: (token: string, accountId: string) => ipcRenderer.invoke(IpcChannels.SitesCfSet, { token, accountId }),
  sitesCfClear: () => ipcRenderer.invoke(IpcChannels.SitesCfClear),

  updateStatus: () => ipcRenderer.invoke(IpcChannels.UpdateStatusGet),
  updateCheck: () => ipcRenderer.invoke(IpcChannels.UpdateCheck),
  onUpdateChanged: (cb) => subscribe(IpcChannels.UpdateChanged, cb),
  updateRestart: () => ipcRenderer.invoke(IpcChannels.UpdateRestart),
  updateChannelSet: (channel) => ipcRenderer.invoke(IpcChannels.UpdateChannelSet, channel),
  onMenuCommand: (cb) => subscribe(IpcChannels.MenuCommand, cb),
  exportThreadMarkdown: (req) => ipcRenderer.invoke(IpcChannels.ThreadExportMarkdown, req)
}

if (process.env.BOSS_E2E === '1') installE2EApi(boss)

contextBridge.exposeInMainWorld('boss', boss)
