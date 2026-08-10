import type {
  ApiRequest,
  ApiResponse,
  BrowseBounds,
  BrowseNavigationState,
  ComputerUseStatus,
  OptionalComponentId,
  OptionalComponentInfo,
  OptionalDownloadEvent,
  ProjectInfo,
  ServerInfo
} from './ipc'

export interface RalfApi {
  platform(): string
  serverInfo(): Promise<ServerInfo>
  onServerStatusChanged(cb: (info: ServerInfo) => void): () => void

  apiRequest(req: ApiRequest): Promise<ApiResponse>

  subscribeEvents(): Promise<boolean>
  unsubscribeEvents(): Promise<boolean>
  onEvent(cb: (data: string) => void): () => void

  browseAttach(bounds: BrowseBounds): Promise<boolean>
  browseDetach(): Promise<boolean>
  browseBounds(bounds: BrowseBounds): Promise<boolean>
  browseNavigate(url: string): Promise<boolean>
  browseBack(): Promise<boolean>
  browseForward(): Promise<boolean>
  browseReload(): Promise<boolean>
  onBrowseNavigation(cb: (state: BrowseNavigationState) => void): () => void
  onBrowseExternal(cb: (url: string) => void): () => void

  optionalList(): Promise<OptionalComponentInfo[]>
  optionalDownload(id: OptionalComponentId): Promise<{ ok: boolean; error?: string }>
  onOptionalProgress(cb: (evt: OptionalDownloadEvent) => void): () => void

  computerUseStatus(): Promise<ComputerUseStatus>
  setComputerUse(on: boolean): Promise<ComputerUseStatus>

  projectCurrent(): Promise<ProjectInfo>
  projectSet(path: string): Promise<ProjectInfo>
  projectChoose(): Promise<string | null>
}
