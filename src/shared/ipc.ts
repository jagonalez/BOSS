export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

export interface ApiRequest {
  method: HttpMethod
  path: string
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
  directory?: string
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

export interface BrowseNavEvent {
  id: string
  state: BrowseNavigationState
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
  supported: boolean
  enabled: boolean
  running: boolean
  error?: string
}

export interface ComputerUsePermissions {
  available: boolean
  accessibility: boolean
  screenRecording: boolean
}

export type PrivacyPane = 'accessibility' | 'screenRecording'

export interface ProjectInfo {
  path: string
  healthy: boolean
}

export interface SiteInfo {
  id: string
  name: string
  folder: string
  localUrl: string
  port: number
  scriptName: string
  deployedUrl?: string
  deploymentAccountId?: string
  lastPublishedAt: number
  status: 'local' | 'deploying' | 'unpublishing' | 'live' | 'error'
  error?: string
}

export interface CloudflareSettings {
  configured: boolean
  accountId?: string
}

export interface TerminalDataEvent {
  id: string
  data: string
}

export interface TerminalExitEvent {
  id: string
  code: number
}

export interface BrowseNavigationState {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
}

export interface TtsSpeakRequest {
  text: string
  voice: string
}

export interface AsrTranscribeRequest {
  pcm: Float32Array
}

export interface AsrTranscribeResult {
  text: string
  error?: string
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
  BrowseDestroy: 'browse:destroy',
  BrowseNavigation: 'browse:navigation',
  BrowseExternal: 'browse:external',
  OpenExternal: 'open-external',
  OpenPath: 'open-path',
  OpenInEditor: 'open-in-editor',
  OptionalList: 'optional:list',
  OptionalDownload: 'optional:download',
  OptionalProgress: 'optional:progress',
  ComputerUseStatus: 'computer-use:status',
  ComputerUseSetEnabled: 'computer-use:set-enabled',
  ComputerUsePermissions: 'computer-use:permissions',
  ComputerUseRequestPermission: 'computer-use:request-permission',
  OpenPrivacyPane: 'open-privacy-pane',
  ProjectCurrent: 'project:current',
  ProjectSet: 'project:set',
  ProjectChoose: 'project:choose',
  TerminalCreate: 'terminal:create',
  TerminalWrite: 'terminal:write',
  TerminalResize: 'terminal:resize',
  TerminalDispose: 'terminal:dispose',
  TerminalData: 'terminal:data',
  TerminalExit: 'terminal:exit',
  GitRun: 'git:run',
  TtsStatus: 'tts:status',
  TtsSpeak: 'tts:speak',
  SpeechStatusChanged: 'speech:status-changed',
  AsrTranscribe: 'asr:transcribe',
  BackendRequest: 'backend:request',
  BackendInfo: 'backend:info',
  WindowToggleMaximize: 'window:toggle-maximize',
  SitesList: 'sites:list',
  SitesPublish: 'sites:publish',
  SitesRemove: 'sites:remove',
  SitesDeploy: 'sites:deploy',
  SitesUnpublish: 'sites:unpublish',
  SitesChooseFolder: 'sites:choose-folder',
  SitesChanged: 'sites:changed',
  SitesCfGet: 'sites:cf:get',
  SitesCfSet: 'sites:cf:set',
  SitesCfClear: 'sites:cf:clear'
} as const

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels]
