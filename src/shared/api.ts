import type {
  ApiRequest,
  ApiResponse,
  AsrTranscribeRequest,
  AsrTranscribeResult,
  BrowseBounds,
  BrowseNavEvent,
  ComputerUsePermissions,
  ComputerUseStatus,
  OptionalComponentId,
  OptionalComponentInfo,
  OptionalDownloadEvent,
  ProjectInfo,
  ServerInfo,
  TerminalDataEvent,
  TerminalExitEvent,
  TtsSpeakRequest
} from './ipc'
import type { SpeechStatus, TtsSpeakResult, TtsStatus } from './speech'
import type { BackendRequest } from './backend'

export interface RalfApi {
  platform(): string
  serverInfo(): Promise<ServerInfo>
  onServerStatusChanged(cb: (info: ServerInfo) => void): () => void

  apiRequest(req: ApiRequest): Promise<ApiResponse>

  subscribeEvents(): Promise<boolean>
  unsubscribeEvents(): Promise<boolean>
  onEvent(cb: (data: string) => void): () => void

  browseAttach(id: string, bounds: BrowseBounds): Promise<boolean>
  browseDetach(id: string): Promise<boolean>
  browseBounds(id: string, bounds: BrowseBounds): Promise<boolean>
  browseNavigate(id: string, url: string): Promise<boolean>
  browseBack(id: string): Promise<boolean>
  browseForward(id: string): Promise<boolean>
  browseReload(id: string): Promise<boolean>
  browseDestroy(id: string): Promise<boolean>
  onBrowseNavigation(cb: (evt: BrowseNavEvent) => void): () => void
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

  projectCurrent(): Promise<ProjectInfo>
  projectSet(path: string): Promise<ProjectInfo>
  projectChoose(): Promise<string | null>

  terminalCreate(cwd?: string, cols?: number, rows?: number): Promise<string>
  terminalWrite(id: string, data: string): Promise<boolean>
  terminalResize(id: string, cols: number, rows: number): Promise<boolean>
  terminalDispose(id: string): Promise<boolean>
  onTerminalData(cb: (evt: TerminalDataEvent) => void): () => void
  onTerminalExit(cb: (evt: TerminalExitEvent) => void): () => void

  gitRun(path: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }>

  ttsStatus(): Promise<TtsStatus>
  ttsSpeak(req: TtsSpeakRequest): Promise<TtsSpeakResult>
  onSpeechStatusChanged(cb: (status: SpeechStatus) => void): () => void

  asrTranscribe(req: AsrTranscribeRequest): Promise<AsrTranscribeResult>

  backendRequest(req: BackendRequest): Promise<unknown>
}
