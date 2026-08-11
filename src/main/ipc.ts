import { dialog, ipcMain, shell, type WebContents } from 'electron'
import { execFile } from 'node:child_process'
import {
  IpcChannels,
  type ApiRequest,
  type BrowseBounds,
  type PrivacyPane,
  type ServerInfo
} from '@shared/ipc'
import type { OpenCodeServer } from './opencode-server'
import type { ApiClient } from './api-client'
import type { EventStream } from './event-stream'
import type { BrowseManager } from './browse'
import type { OptionalDeps } from './optional-deps'
import type { ComputerUse } from './computer-use'
import type { PTYManager } from './pty-manager'
import type { SpeechManager } from './speech'
import type { SitesManager } from './sites'
import type { AsrTranscribeRequest, TtsSpeakRequest } from '@shared/ipc'

export interface IpcDeps {
  server: OpenCodeServer
  api: ApiClient
  events: EventStream
  browse: BrowseManager
  optional: OptionalDeps
  computerUse: ComputerUse
  pty: PTYManager
  speech: SpeechManager
  sites: SitesManager
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
  deps.browse.onNavigation = (id, state) => broadcast(IpcChannels.BrowseNavigation, { id, state })
  deps.browse.onExternal = (url) => broadcast(IpcChannels.BrowseExternal, url)
  deps.computerUse.onStatusChange = (status) => broadcast(IpcChannels.ComputerUseStatus, status)
  deps.pty.onData = (id, data) => broadcast(IpcChannels.TerminalData, { id, data })
  deps.pty.onExit = (id, code) => broadcast(IpcChannels.TerminalExit, { id, code })
  deps.speech.onStatusChange = (status) => broadcast(IpcChannels.SpeechStatusChanged, status)
  deps.sites.onChanged = (sites) => broadcast(IpcChannels.SitesChanged, sites)

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

  ipcMain.handle(IpcChannels.BrowseAttach, (_e, body: { id: string; bounds: BrowseBounds }) => {
    deps.browse.attach(body.id, body.bounds)
    return true
  })

  ipcMain.handle(IpcChannels.BrowseDetach, (_e, id: string) => {
    deps.browse.detach(id)
    return true
  })

  ipcMain.handle(IpcChannels.BrowseBounds, (_e, body: { id: string; bounds: BrowseBounds }) => {
    deps.browse.setBounds(body.id, body.bounds)
    return true
  })

  ipcMain.handle(IpcChannels.BrowseNavigate, (_e, body: { id: string; url: string }) => {
    deps.browse.navigate(body.id, body.url)
    return true
  })

  ipcMain.handle(IpcChannels.BrowseGoBack, (_e, id: string) => {
    deps.browse.goBack(id)
    return true
  })

  ipcMain.handle(IpcChannels.BrowseGoForward, (_e, id: string) => {
    deps.browse.goForward(id)
    return true
  })

  ipcMain.handle(IpcChannels.BrowseReload, (_e, id: string) => {
    deps.browse.reload(id)
    return true
  })

  ipcMain.handle(IpcChannels.BrowseDestroy, (_e, id: string) => {
    deps.browse.destroy(id)
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

  ipcMain.handle(IpcChannels.ComputerUsePermissions, () => deps.computerUse.permissions())

  ipcMain.handle(IpcChannels.ComputerUseRequestPermission, (_e, pane: PrivacyPane) =>
    deps.computerUse.requestPermission(pane)
  )

  ipcMain.handle(IpcChannels.OpenPrivacyPane, (_e, pane: PrivacyPane) => {
    const url =
      pane === 'screenRecording'
        ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
        : 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
    void shell.openExternal(url)
    return true
  })

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

  ipcMain.handle(IpcChannels.TtsStatus, () => deps.speech.ttsStatus())

  ipcMain.handle(IpcChannels.TtsSpeak, (_e, req: TtsSpeakRequest) => deps.speech.speak(req.text, req.voice))

  ipcMain.handle(IpcChannels.AsrTranscribe, (_e, req: AsrTranscribeRequest) => deps.speech.transcribe(req.pcm))

  ipcMain.handle(IpcChannels.SitesList, () => deps.sites.list())

  ipcMain.handle(IpcChannels.SitesPublish, (_e, body: { folder: string; name?: string }) =>
    deps.sites.publish(body.folder, body.name)
  )

  ipcMain.handle(IpcChannels.SitesRemove, (_e, id: string) => deps.sites.remove(id))

  ipcMain.handle(IpcChannels.SitesDeploy, (_e, id: string) => deps.sites.deploy(id))

  ipcMain.handle(IpcChannels.SitesChooseFolder, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Publish a site folder',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle(IpcChannels.SitesCfGet, () => deps.sites.cloudflareGet())

  ipcMain.handle(IpcChannels.SitesCfSet, (_e, body: { token: string; accountId: string }) =>
    deps.sites.cloudflareSet(body.token, body.accountId)
  )

  ipcMain.handle(IpcChannels.SitesCfClear, () => deps.sites.cloudflareClear())
}
