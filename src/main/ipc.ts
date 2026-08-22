import { BrowserWindow, clipboard, dialog, ipcMain, shell, type WebContents } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  IpcChannels,
  type ApiRequest,
  type PrivacyPane,
  type ProjectInfo,
  type ProjectOpenedEvent,
  type ServerInfo
} from '@shared/ipc'
import type { OpenCodeServer } from './opencode-server'
import type { ApiClient } from './api-client'
import type { ProjectFiles } from './project-files'
import type { EventStream } from './event-stream'
import type { BrowseManager } from './browse'
import type { OptionalDeps } from './optional-deps'
import type { ComputerUse } from './computer-use'
import type { PTYManager } from './pty-manager'
import type { SpeechManager } from './speech'
import type { SitesManager } from './sites'
import type { UpdateChecker } from './updates'
import type { BackendManager } from './backend/manager'
import type { BackendRequest } from '@shared/backend'
import type { AsrTranscribeRequest, TtsSpeakRequest, UpdateChannel } from '@shared/ipc'
import type { ReviewManager } from './review-manager'
import { projectCheckouts } from './project-identity'
import { cliStatus, installCli, uninstallCli } from './cli-command'
import { loadState, saveState } from './state-store'
import { orderedProjects } from '@shared/projects'

export interface IpcDeps {
  server: OpenCodeServer
  api: ApiClient
  events: EventStream
  backends: BackendManager
  browse: BrowseManager
  optional: OptionalDeps
  computerUse: ComputerUse
  pty: PTYManager
  speech: SpeechManager
  sites: SitesManager
  updates: UpdateChecker
  reviews: ReviewManager
  projectFiles: ProjectFiles
  /** A `boss` command result that landed before the renderer could listen.
   *  Collected once, on mount. */
  takePendingCliOpen: () => ProjectOpenedEvent | null
}

/** Make a folder the active project, remembering it if it is a new one.
 *
 *  The only way a project is opened. The renderer reaches it through
 *  `project:set`, and the `boss` command reaches it through `second-instance`,
 *  so a folder opened from a terminal is canonicalised and recorded by exactly
 *  the same rules as one picked in the app.
 *
 *  A linked worktree is a checkout within its repository project, not a second
 *  project. Keep project navigation canonical while review/files/terminal
 *  surfaces retain their own checkout-specific context paths. */
export async function openProject(deps: IpcDeps, path: string): Promise<ProjectInfo> {
  const scope = deps.backends.scopeFor(path)
  await deps.backends.setProject(scope.projectPath)
  // Record the project here rather than in OpenCodeServer.setProject, so a
  // project opened without opencode is still remembered and still listed.
  if (scope.projectPath) {
    const known = loadState().projects ?? []
    saveState({
      projectPath: scope.projectPath,
      projects: known.includes(scope.projectPath) ? known : [...known, scope.projectPath]
    })
  }
  return {
    path: scope.projectPath,
    checkoutPath: scope.executionPath,
    checkouts: projectCheckouts(scope.projectPath),
    healthy: deps.server.info.healthy
  }
}

export function registerIpc(deps: IpcDeps): void {
  const subscribers = new Set<WebContents>()

  function broadcast(channel: string, payload: unknown): void {
    for (const wc of subscribers) {
      if (!wc.isDestroyed()) wc.send(channel, payload)
    }
  }

  deps.server.onStatusChange = (info: ServerInfo) => broadcast(IpcChannels.ServerStatusChanged, info)
  deps.backends.onEvent((event) => broadcast(IpcChannels.EventData, JSON.stringify(event)))
  deps.browse.onNavigation = (id, state) => broadcast(IpcChannels.BrowseNavigation, { id, state })
  deps.browse.onExternal = (url) => broadcast(IpcChannels.BrowseExternal, url)
  deps.browse.onAgentActivity = (id) => broadcast(IpcChannels.BrowseAgentActivity, id)
  deps.computerUse.onStatusChange = (status) => broadcast(IpcChannels.ComputerUseStatus, status)
  deps.pty.onData = (id, data) => broadcast(IpcChannels.TerminalData, { id, data })
  deps.pty.onExit = (id, code) => broadcast(IpcChannels.TerminalExit, { id, code })
  deps.speech.onStatusChange = (status) => broadcast(IpcChannels.SpeechStatusChanged, status)
  deps.sites.onChanged = (sites) => broadcast(IpcChannels.SitesChanged, sites)

  ipcMain.handle(IpcChannels.WindowToggleMaximize, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })

  ipcMain.handle(IpcChannels.ServerGetInfo, () => deps.server.info)

  ipcMain.handle(IpcChannels.ApiRequest, (_e, req: ApiRequest) => deps.api.request(req))

  // Read straight from disk rather than through opencode's HTTP server. The
  // Files tab is a local directory listing; routing it through an optional
  // 90 MB engine made it empty for anyone who had not installed one.
  ipcMain.handle(IpcChannels.ProjectFileTree, (_e, body: { root: string; path?: string }) =>
    deps.projectFiles.list(body.root, body.path ?? '')
  )

  ipcMain.handle(IpcChannels.ProjectFilePreview, (_e, body: { root: string; path: string }) =>
    deps.projectFiles.preview(body.root, body.path) ?? null
  )

  ipcMain.handle(IpcChannels.BackendRequest, (_e, req: BackendRequest) => deps.backends.handle(req))

  ipcMain.handle(IpcChannels.EventSubscribe, (e) => {
    subscribers.add(e.sender)
    return true
  })

  ipcMain.handle(IpcChannels.EventUnsubscribe, (e) => {
    subscribers.delete(e.sender)
    return true
  })

  // Placement is the renderer's job now: a webview is a DOM element. All the
  // main process needs is a handle on the guest page, so agent tools can reach
  // it without a hop back through the renderer.
  ipcMain.handle(IpcChannels.BrowseRegister, (_e, body: { id: string; webContentsId: number }) => {
    deps.browse.register(body.id, body.webContentsId)
    return true
  })

  ipcMain.handle(IpcChannels.BrowseUnregister, (_e, id: string) => {
    deps.browse.unregister(id)
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

  ipcMain.handle(IpcChannels.ProjectCurrent, () => {
    const current = deps.backends.currentProject || deps.server.projectPath
    const scope = deps.backends.scopeFor(current)
    return {
      path: scope.projectPath,
      checkoutPath: scope.executionPath,
      checkouts: projectCheckouts(scope.projectPath),
      healthy: deps.server.info.healthy
    }
  })

  ipcMain.handle(IpcChannels.ProjectSet, (_e, path: string) => openProject(deps, path))

  ipcMain.handle(IpcChannels.ProjectList, () =>
    (loadState().projects ?? []).filter((path) => existsSync(path))
  )

  ipcMain.handle(IpcChannels.ProjectForget, (_e, path: string) => {
    const known = loadState().projects ?? []
    const next = known.filter((candidate) => candidate !== path)
    saveState({ projects: next })
    return next
  })

  ipcMain.handle(IpcChannels.ProjectReorder, (_e, paths: string[]) => {
    const next = orderedProjects(paths, loadState().projects ?? [])
    saveState({ projects: next })
    return next
  })

  ipcMain.handle(IpcChannels.ProjectOpenedPending, () => deps.takePendingCliOpen())

  ipcMain.handle(IpcChannels.CliStatus, () => cliStatus())
  ipcMain.handle(IpcChannels.CliInstall, () => installCli())
  ipcMain.handle(IpcChannels.CliUninstall, () => uninstallCli())

  ipcMain.handle(IpcChannels.ProjectChoose, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Open a project folder',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle(IpcChannels.TerminalCreate, (_e, body: { cwd?: string; cols?: number; rows?: number; authBackendId?: import('@shared/backend').BackendId }) => {
    return deps.pty.create(body.cwd, body.cols ?? 80, body.rows ?? 24, body.authBackendId)
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

  ipcMain.on(IpcChannels.TerminalAck, (_e, body: { id: string; chars: number }) => {
    deps.pty.acknowledge(body.id, body.chars)
  })

  ipcMain.on(IpcChannels.TerminalReady, (_e, id: string) => {
    deps.pty.start(id)
  })

  // The renderer cannot reach the clipboard itself: the web API is behind a
  // permission it is not granted, and the preload is sandboxed, so Electron's
  // clipboard module is only available here.
  ipcMain.on(IpcChannels.ClipboardRead, (event) => {
    event.returnValue = clipboard.readText()
  })

  ipcMain.on(IpcChannels.ClipboardWrite, (_e, text: string) => {
    clipboard.writeText(text)
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

  ipcMain.handle(IpcChannels.ReviewSnapshot, (_event, path: string) => deps.reviews.snapshot(path))
  ipcMain.handle(IpcChannels.ReviewChangeRequestDiff, (_event, path: string) => deps.reviews.changeRequestDiff(path))
  ipcMain.handle(IpcChannels.ReviewLocalAdd, (_event, body: { path: string; input: import('@shared/review').AddReviewCommentInput }) =>
    deps.reviews.addLocal(body.path, body.input)
  )
  ipcMain.handle(IpcChannels.ReviewLocalDelete, (_event, body: { path: string; commentId: string }) =>
    deps.reviews.deleteLocal(body.path, body.commentId)
  )
  ipcMain.handle(IpcChannels.ReviewPublishComment, (_event, body: { path: string; input: import('@shared/review').AddReviewCommentInput }) =>
    deps.reviews.publishComment(body.path, body.input)
  )
  ipcMain.handle(IpcChannels.ReviewReply, (_event, body: { path: string; commentId: string; body: string }) =>
    deps.reviews.reply(body.path, body.commentId, body.body)
  )
  ipcMain.handle(IpcChannels.ReviewSubmit, (_event, body: { path: string; event: import('@shared/review').SubmitReviewEvent; body: string }) =>
    deps.reviews.submit(body.path, body.event, body.body)
  )

  ipcMain.handle(IpcChannels.TtsStatus, () => deps.speech.ttsStatus())

  ipcMain.handle(IpcChannels.TtsSpeak, (_e, req: TtsSpeakRequest) => deps.speech.speak(req.text, req.voice))

  ipcMain.handle(IpcChannels.AsrTranscribe, (_e, req: AsrTranscribeRequest) => deps.speech.transcribe(req.pcm))

  ipcMain.handle(IpcChannels.SitesList, () => deps.sites.list())

  ipcMain.handle(IpcChannels.SitesPublish, (_e, body: { folder: string; name?: string }) =>
    deps.sites.publish(body.folder, body.name)
  )

  ipcMain.handle(IpcChannels.SitesRemove, (_e, id: string) => deps.sites.remove(id))

  ipcMain.handle(IpcChannels.SitesDeploy, (_e, id: string) => deps.sites.deploy(id))

  ipcMain.handle(IpcChannels.SitesUnpublish, (_e, id: string) => deps.sites.unpublish(id))

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

  ipcMain.handle(IpcChannels.UpdateStatusGet, () => deps.updates.status())
  ipcMain.handle(IpcChannels.UpdateRestart, () => deps.updates.restart())
  ipcMain.handle(IpcChannels.UpdateChannelSet, async (_e, channel: UpdateChannel) => {
    const status = await deps.updates.setChannel(channel)
    broadcast(IpcChannels.UpdateChanged, status)
    return status
  })
  ipcMain.handle(IpcChannels.UpdateCheck, async () => {
    const status = await deps.updates.check()
    broadcast(IpcChannels.UpdateChanged, status)
    return status
  })
}
