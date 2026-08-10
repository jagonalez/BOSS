import { dialog, ipcMain, shell, type WebContents } from 'electron'
import { execFile } from 'node:child_process'
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
import type { PTYManager } from './pty-manager'

export interface IpcDeps {
  server: OpenCodeServer
  api: ApiClient
  events: EventStream
  browse: BrowseManager
  optional: OptionalDeps
  computerUse: ComputerUse
  pty: PTYManager
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
  deps.pty.onData = (id, data) => broadcast(IpcChannels.TerminalData, { id, data })
  deps.pty.onExit = (id, code) => broadcast(IpcChannels.TerminalExit, { id, code })

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

  ipcMain.handle(IpcChannels.OpenExternal, (_e, url: string) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return true
  })

  ipcMain.handle(IpcChannels.OpenPath, (_e, path: string) => {
    void shell.openPath(path)
    return true
  })

  ipcMain.handle(IpcChannels.OpenInEditor, (_e, body: { path: string; line?: number }) => {
    const line = body.line ?? 1
    execFile('code', ['-g', `${body.path}:${line}`], (err) => {
      if (err) void shell.openPath(body.path)
    })
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

  ipcMain.handle(IpcChannels.TerminalCreate, (_e, body: { cwd?: string; cols?: number; rows?: number }) => {
    return deps.pty.create(body.cwd, body.cols ?? 80, body.rows ?? 24)
  })

  ipcMain.handle(IpcChannels.TerminalWrite, (_e, body: { id: string; data: string }) => {
    deps.pty.write(body.id, body.data)
    return true
  })

  ipcMain.handle(IpcChannels.TerminalResize, (_e, body: { id: string; cols: number; rows: number }) => {
    deps.pty.resize(body.id, body.cols, body.rows)
    return true
  })

  ipcMain.handle(IpcChannels.TerminalDispose, (_e, id: string) => {
    deps.pty.dispose(id)
    return true
  })

  ipcMain.handle(IpcChannels.GitRun, (_event, body: { path: string; args: string[] }) => {
    return new Promise((resolve) => {
      execFile('git', body.args, { cwd: body.path, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({
          code: err ? (err as NodeJS.ErrnoException).code ?? 1 : 0,
          stdout: String(stdout),
          stderr: String(stderr)
        })
      })
    })
  })
}
