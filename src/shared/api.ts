import type {
  ApiRequest,
  ApiResponse,
  AsrTranscribeRequest,
  AsrTranscribeResult,
  BrowseNavEvent,
  ComputerUsePermissions,
  ComputerUseStatus,
  OptionalComponentId,
  OptionalComponentInfo,
  OptionalDownloadEvent,
  ProjectInfo,
  ServerInfo,
  SiteInfo,
  CloudflareSettings,
  TerminalDataEvent,
  TerminalExitEvent,
  TtsSpeakRequest,
  UpdateStatus
} from './ipc'
import type { SpeechStatus, TtsSpeakResult, TtsStatus } from './speech'
import type { BackendRequest } from './backend'
import type { AddReviewCommentInput, ChangeRequestFileDiff, ReviewComment, ReviewSnapshot, SubmitReviewEvent } from './review'

export interface BossApi {
  platform(): string
  toggleMaximize(): Promise<boolean>
  serverInfo(): Promise<ServerInfo>
  onServerStatusChanged(cb: (info: ServerInfo) => void): () => void

  apiRequest(req: ApiRequest): Promise<ApiResponse>

  subscribeEvents(): Promise<boolean>
  unsubscribeEvents(): Promise<boolean>
  onEvent(cb: (data: string) => void): () => void

  /** Hand a webview's guest page to the main process, so agent tools can drive
   *  it directly. Placement is the renderer's own business. */
  browseRegister(id: string, webContentsId: number): Promise<boolean>
  browseUnregister(id: string): Promise<boolean>
  browseNavigate(id: string, url: string): Promise<boolean>
  browseBack(id: string): Promise<boolean>
  browseForward(id: string): Promise<boolean>
  browseReload(id: string): Promise<boolean>
  browseDestroy(id: string): Promise<boolean>
  onBrowseNavigation(cb: (evt: BrowseNavEvent) => void): () => void
  /** An agent drove a browser tab, which may not be the one on screen. */
  onBrowseAgentActivity(cb: (id: string) => void): () => void
  onBrowseExternal(cb: (url: string) => void): () => void
  openExternal(url: string): Promise<boolean>
  openPath(path: string): Promise<boolean>
  openInEditor(path: string, line?: number): Promise<boolean>

  optionalList(): Promise<OptionalComponentInfo[]>
  optionalDownload(id: OptionalComponentId): Promise<{ ok: boolean; error?: string }>
  onOptionalProgress(cb: (evt: OptionalDownloadEvent) => void): () => void

  computerUseStatus(): Promise<ComputerUseStatus>
  setComputerUse(on: boolean): Promise<ComputerUseStatus>
  computerUsePermissions(): Promise<ComputerUsePermissions>
  requestComputerUsePermission(pane: 'accessibility' | 'screenRecording'): Promise<boolean>
  openPrivacyPane(pane: 'accessibility' | 'screenRecording'): Promise<boolean>

  /** Projects BOSS itself has opened. Independent of any backend. */
  projectList(): Promise<string[]>
  projectForget(path: string): Promise<string[]>
  projectCurrent(): Promise<ProjectInfo>
  projectSet(path: string): Promise<ProjectInfo>
  projectChoose(): Promise<string | null>

  terminalCreate(cwd?: string, cols?: number, rows?: number, authBackendId?: import('./backend').BackendId): Promise<string>
  terminalWrite(id: string, data: string): Promise<boolean>
  terminalResize(id: string, cols: number, rows: number): Promise<boolean>
  terminalDispose(id: string): Promise<boolean>
  onTerminalData(cb: (evt: TerminalDataEvent) => void): () => void
  onTerminalExit(cb: (evt: TerminalExitEvent) => void): () => void

  gitRun(path: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }>
  reviewSnapshot(path: string): Promise<ReviewSnapshot>
  reviewChangeRequestDiff(path: string): Promise<ChangeRequestFileDiff[]>
  reviewLocalAdd(path: string, input: AddReviewCommentInput): Promise<ReviewComment>
  reviewLocalDelete(path: string, commentId: string): Promise<boolean>
  reviewPublishComment(path: string, input: AddReviewCommentInput): Promise<ReviewSnapshot>
  reviewReply(path: string, commentId: string, body: string): Promise<ReviewSnapshot>
  reviewSubmit(path: string, event: SubmitReviewEvent, body: string): Promise<ReviewSnapshot>

  ttsStatus(): Promise<TtsStatus>
  ttsSpeak(req: TtsSpeakRequest): Promise<TtsSpeakResult>
  onSpeechStatusChanged(cb: (status: SpeechStatus) => void): () => void

  asrTranscribe(req: AsrTranscribeRequest): Promise<AsrTranscribeResult>

  backendRequest(req: BackendRequest): Promise<unknown>

  sitesList(): Promise<SiteInfo[]>
  sitesPublish(folder: string, name?: string): Promise<SiteInfo>
  sitesRemove(id: string): Promise<void>
  sitesDeploy(id: string): Promise<SiteInfo>
  sitesUnpublish(id: string): Promise<SiteInfo>
  sitesChooseFolder(): Promise<string | null>
  onSitesChanged(cb: (sites: SiteInfo[]) => void): () => void
  sitesCfGet(): Promise<CloudflareSettings>
  sitesCfSet(token: string, accountId: string): Promise<CloudflareSettings>
  sitesCfClear(): Promise<CloudflareSettings>

  updateStatus(): Promise<UpdateStatus>
  updateCheck(): Promise<UpdateStatus>
  onUpdateChanged(cb: (status: UpdateStatus) => void): () => void
  /** Apply a staged update now instead of at the next quit. */
  updateRestart(): Promise<void>
  /** A menu item was chosen. The menu names the action; the renderer runs it. */
  onMenuCommand(cb: (command: import('./ipc').MenuCommand) => void): () => void
}
