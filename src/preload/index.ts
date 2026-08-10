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
  serverInfo: () => ipcRenderer.invoke(IpcChannels.ServerGetInfo),
  onServerStatusChanged: (cb) => subscribe(IpcChannels.ServerStatusChanged, cb),

  apiRequest: (req: ApiRequest) => ipcRenderer.invoke(IpcChannels.ApiRequest, req),

  subscribeEvents: () => ipcRenderer.invoke(IpcChannels.EventSubscribe),
  unsubscribeEvents: () => ipcRenderer.invoke(IpcChannels.EventUnsubscribe),
  onEvent: (cb) => subscribe(IpcChannels.EventData, cb),

  browseAttach: (bounds: BrowseBounds) => ipcRenderer.invoke(IpcChannels.BrowseAttach, bounds),
  browseDetach: () => ipcRenderer.invoke(IpcChannels.BrowseDetach),
  browseBounds: (bounds: BrowseBounds) => ipcRenderer.invoke(IpcChannels.BrowseBounds, bounds),
  browseNavigate: (url: string) => ipcRenderer.invoke(IpcChannels.BrowseNavigate, url),
  browseBack: () => ipcRenderer.invoke(IpcChannels.BrowseGoBack),
  browseForward: () => ipcRenderer.invoke(IpcChannels.BrowseGoForward),
  browseReload: () => ipcRenderer.invoke(IpcChannels.BrowseReload),
  onBrowseNavigation: (cb) => subscribe(IpcChannels.BrowseNavigation, cb),
  onBrowseExternal: (cb) => subscribe(IpcChannels.BrowseExternal, cb),

  optionalList: () => ipcRenderer.invoke(IpcChannels.OptionalList),
  optionalDownload: (id) => ipcRenderer.invoke(IpcChannels.OptionalDownload, id),
  onOptionalProgress: (cb) => subscribe(IpcChannels.OptionalProgress, cb),

  computerUseStatus: () => ipcRenderer.invoke(IpcChannels.ComputerUseStatus),
  setComputerUse: (on: boolean) => ipcRenderer.invoke(IpcChannels.ComputerUseSetEnabled, on),

  projectCurrent: () => ipcRenderer.invoke(IpcChannels.ProjectCurrent),
  projectSet: (path: string) => ipcRenderer.invoke(IpcChannels.ProjectSet, path),
  projectChoose: () => ipcRenderer.invoke(IpcChannels.ProjectChoose)
}

contextBridge.exposeInMainWorld('ralf', ralf)
