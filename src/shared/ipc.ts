export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

export interface ApiRequest {
  method: HttpMethod
  path: string
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
}

export interface ApiResponse {
  status: number
  body: unknown
}

export interface ServerInfo {
  port: number
  url: string
  version: string
  healthy: boolean
}

export interface BrowseBounds {
  x: number
  y: number
  width: number
  height: number
}

export type OptionalComponentId = 'opencode' | 'browser-core' | 'computer-use'

export interface OptionalComponentInfo {
  id: OptionalComponentId
  installed: boolean
  version?: string
  optional: boolean
  sizeMb?: number
}

export interface OptionalDownloadEvent {
  id: OptionalComponentId
  phase: 'downloading' | 'extracting' | 'done' | 'error'
  received?: number
  total?: number
  error?: string
}

export interface ComputerUseStatus {
  enabled: boolean
  running: boolean
  error?: string
}

export interface ProjectInfo {
  path: string
  healthy: boolean
}

export interface BrowseNavigationState {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
}

export const IpcChannels = {
  ServerGetInfo: 'server:get-info',
  ServerStatusChanged: 'server:status-changed',
  ApiRequest: 'api:request',
  EventSubscribe: 'events:subscribe',
  EventUnsubscribe: 'events:unsubscribe',
  EventData: 'events:data',
  BrowseAttach: 'browse:attach',
  BrowseDetach: 'browse:detach',
  BrowseBounds: 'browse:bounds',
  BrowseNavigate: 'browse:navigate',
  BrowseGoBack: 'browse:go-back',
  BrowseGoForward: 'browse:go-forward',
  BrowseReload: 'browse:reload',
  BrowseNavigation: 'browse:navigation',
  BrowseExternal: 'browse:external',
  OptionalList: 'optional:list',
  OptionalDownload: 'optional:download',
  OptionalProgress: 'optional:progress',
  ComputerUseStatus: 'computer-use:status',
  ComputerUseSetEnabled: 'computer-use:set-enabled',
  ProjectCurrent: 'project:current',
  ProjectSet: 'project:set',
  ProjectChoose: 'project:choose'
} as const

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels]
