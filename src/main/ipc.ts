import { dialog, ipcMain, type WebContents } from 'electron'
import {
  IpcChannels,
  type ApiRequest,
  type BrowseBounds,
  type ServerInfo
} from '@shared/ipc'
import type { OpenCodeServer } from './opencode-server'
import type { ApiClient } from './api-client'
import type { EventStream } from './event-stream'
import type { BrowseManager } from './browse'
import type { OptionalDeps } from './optional-deps'
import type { ComputerUse } from './computer-use'

export interface IpcDeps {
  server: OpenCodeServer
  api: ApiClient
  events: EventStream
  browse: BrowseManager
  optional: OptionalDeps
  computerUse: ComputerUse
}

export function registerIpc(deps: IpcDeps): void {
  const subscribers = new Set<WebContents>()

  function broadcast(channel: string, payload: unknown): void {
    for (const wc of subscribers) {
      if (!wc.isDestroyed()) wc.send(channel, payload)
    }
  }

  deps.server.onStatusChange = (info: ServerInfo) => broadcast(IpcChannels.ServerStatusChanged, info)
  deps.events.onEvent = (data: string) => broadcast(IpcChannels.EventData, data)
  deps.browse.onNavigation = (state) => broadcast(IpcChannels.BrowseNavigation, state)
  deps.browse.onExternal = (url) => broadcast(IpcChannels.BrowseExternal, url)
  deps.computerUse.onStatusChange = (status) => broadcast(IpcChannels.ComputerUseStatus, status)

  ipcMain.handle(IpcChannels.ServerGetInfo, () => deps.server.info)

  ipcMain.handle(IpcChannels.ApiRequest, (_e, req: ApiRequest) => deps.api.request(req))

  ipcMain.handle(IpcChannels.EventSubscribe, (e) => {
    subscribers.add(e.sender)
    return true
  })

  ipcMain.handle(IpcChannels.EventUnsubscribe, (e) => {
    subscribers.delete(e.sender)
    return true
  })

  ipcMain.handle(IpcChannels.BrowseAttach, (_e, bounds: BrowseBounds) => {
    deps.browse.attach(bounds)
    return true
  })

  ipcMain.handle(IpcChannels.BrowseDetach, () => {
    deps.browse.detach()
    return true
  })

  ipcMain.handle(IpcChannels.BrowseBounds, (_e, bounds: BrowseBounds) => {
    deps.browse.setBounds(bounds)
    return true
  })

  ipcMain.handle(IpcChannels.BrowseNavigate, (_e, url: string) => {
    deps.browse.navigate(url)
    return true
  })

  ipcMain.handle(IpcChannels.BrowseGoBack, () => {
    deps.browse.goBack()
    return true
  })

  ipcMain.handle(IpcChannels.BrowseGoForward, () => {
    deps.browse.goForward()
    return true
  })

  ipcMain.handle(IpcChannels.BrowseReload, () => {
    deps.browse.reload()
    return true
  })

  ipcMain.handle(IpcChannels.OptionalList, () => deps.optional.list())

  ipcMain.handle(IpcChannels.OptionalDownload, async (event, id) => {
    try {
      await deps.optional.download(id, (evt) => {
        if (!event.sender.isDestroyed()) event.sender.send(IpcChannels.OptionalProgress, evt)
      })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) }
    }
  })

  ipcMain.handle(IpcChannels.ComputerUseStatus, () => deps.computerUse.status)

  ipcMain.handle(IpcChannels.ComputerUseSetEnabled, (_e, on: boolean) => deps.computerUse.setEnabled(on))

  ipcMain.handle(IpcChannels.ProjectCurrent, () => ({
    path: deps.server.projectPath,
    healthy: deps.server.info.healthy
  }))

  ipcMain.handle(IpcChannels.ProjectSet, async (_e, path: string) => {
    await deps.server.setProject(path)
    return { path: deps.server.projectPath, healthy: deps.server.info.healthy }
  })

  ipcMain.handle(IpcChannels.ProjectChoose, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Open a project folder',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
}
