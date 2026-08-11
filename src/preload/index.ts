import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IpcChannels,
  type ApiRequest,
  type BrowseBounds
} from '../shared/ipc'
import type { RalfApi } from '../shared/api'

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const ralf: RalfApi = {
  platform: () => process.platform,
  toggleMaximize: () => ipcRenderer.invoke(IpcChannels.WindowToggleMaximize),
  serverInfo: () => ipcRenderer.invoke(IpcChannels.ServerGetInfo),
  onServerStatusChanged: (cb) => subscribe(IpcChannels.ServerStatusChanged, cb),

  apiRequest: (req: ApiRequest) => ipcRenderer.invoke(IpcChannels.ApiRequest, req),

  subscribeEvents: () => ipcRenderer.invoke(IpcChannels.EventSubscribe),
  unsubscribeEvents: () => ipcRenderer.invoke(IpcChannels.EventUnsubscribe),
  onEvent: (cb) => subscribe(IpcChannels.EventData, cb),

  browseAttach: (id: string, bounds: BrowseBounds) => ipcRenderer.invoke(IpcChannels.BrowseAttach, { id, bounds }),
  browseDetach: (id: string) => ipcRenderer.invoke(IpcChannels.BrowseDetach, id),
  browseBounds: (id: string, bounds: BrowseBounds) => ipcRenderer.invoke(IpcChannels.BrowseBounds, { id, bounds }),
  browseNavigate: (id: string, url: string) => ipcRenderer.invoke(IpcChannels.BrowseNavigate, { id, url }),
  browseBack: (id: string) => ipcRenderer.invoke(IpcChannels.BrowseGoBack, id),
  browseForward: (id: string) => ipcRenderer.invoke(IpcChannels.BrowseGoForward, id),
  browseReload: (id: string) => ipcRenderer.invoke(IpcChannels.BrowseReload, id),
  browseDestroy: (id: string) => ipcRenderer.invoke(IpcChannels.BrowseDestroy, id),
  onBrowseNavigation: (cb) => subscribe(IpcChannels.BrowseNavigation, cb),
  onBrowseExternal: (cb) => subscribe(IpcChannels.BrowseExternal, cb),
  openExternal: (url: string) => ipcRenderer.invoke(IpcChannels.OpenExternal, url),
  openPath: (path: string) => ipcRenderer.invoke(IpcChannels.OpenPath, path),
  openInEditor: (path: string, line?: number) => ipcRenderer.invoke(IpcChannels.OpenInEditor, { path, line }),

  optionalList: () => ipcRenderer.invoke(IpcChannels.OptionalList),
  optionalDownload: (id) => ipcRenderer.invoke(IpcChannels.OptionalDownload, id),
  onOptionalProgress: (cb) => subscribe(IpcChannels.OptionalProgress, cb),

  computerUseStatus: () => ipcRenderer.invoke(IpcChannels.ComputerUseStatus),
  setComputerUse: (on: boolean) => ipcRenderer.invoke(IpcChannels.ComputerUseSetEnabled, on),
  computerUsePermissions: () => ipcRenderer.invoke(IpcChannels.ComputerUsePermissions),
  requestComputerUsePermission: (pane: 'accessibility' | 'screenRecording') =>
    ipcRenderer.invoke(IpcChannels.ComputerUseRequestPermission, pane),
  openPrivacyPane: (pane: 'accessibility' | 'screenRecording') => ipcRenderer.invoke(IpcChannels.OpenPrivacyPane, pane),

  projectCurrent: () => ipcRenderer.invoke(IpcChannels.ProjectCurrent),
  projectSet: (path: string) => ipcRenderer.invoke(IpcChannels.ProjectSet, path),
  projectChoose: () => ipcRenderer.invoke(IpcChannels.ProjectChoose),

  terminalCreate: (cwd?: string, cols?: number, rows?: number, authBackendId?: import('../shared/backend').BackendId) =>
    ipcRenderer.invoke(IpcChannels.TerminalCreate, { cwd, cols, rows, authBackendId }),
  terminalWrite: (id: string, data: string) => ipcRenderer.invoke(IpcChannels.TerminalWrite, { id, data }),
  terminalResize: (id: string, cols: number, rows: number) =>
    ipcRenderer.invoke(IpcChannels.TerminalResize, { id, cols, rows }),
  terminalDispose: (id: string) => ipcRenderer.invoke(IpcChannels.TerminalDispose, id),
  onTerminalData: (cb) => subscribe(IpcChannels.TerminalData, cb),
  onTerminalExit: (cb) => subscribe(IpcChannels.TerminalExit, cb),
  gitRun: (path: string, args: string[]) => ipcRenderer.invoke(IpcChannels.GitRun, { path, args }),

  ttsStatus: () => ipcRenderer.invoke(IpcChannels.TtsStatus),
  ttsSpeak: (req) => ipcRenderer.invoke(IpcChannels.TtsSpeak, req),
  onSpeechStatusChanged: (cb) => subscribe(IpcChannels.SpeechStatusChanged, cb),

  asrTranscribe: (req) => ipcRenderer.invoke(IpcChannels.AsrTranscribe, req),

  backendRequest: (req) => ipcRenderer.invoke(IpcChannels.BackendRequest, req),

  sitesList: () => ipcRenderer.invoke(IpcChannels.SitesList),
  sitesPublish: (folder: string, name?: string) => ipcRenderer.invoke(IpcChannels.SitesPublish, { folder, name }),
  sitesRemove: (id: string) => ipcRenderer.invoke(IpcChannels.SitesRemove, id),
  sitesDeploy: (id: string) => ipcRenderer.invoke(IpcChannels.SitesDeploy, id),
  sitesUnpublish: (id: string) => ipcRenderer.invoke(IpcChannels.SitesUnpublish, id),
  sitesChooseFolder: () => ipcRenderer.invoke(IpcChannels.SitesChooseFolder),
  onSitesChanged: (cb) => subscribe(IpcChannels.SitesChanged, cb),
  sitesCfGet: () => ipcRenderer.invoke(IpcChannels.SitesCfGet),
  sitesCfSet: (token: string, accountId: string) => ipcRenderer.invoke(IpcChannels.SitesCfSet, { token, accountId }),
  sitesCfClear: () => ipcRenderer.invoke(IpcChannels.SitesCfClear)
}

contextBridge.exposeInMainWorld('ralf', ralf)
