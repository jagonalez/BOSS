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

/** Which releases this copy offers to install.
 *
 *  Beta exists because BOSS is built with BOSS: without it the only way to try
 *  a change in the real app is to cut a full signed release by hand. */
export type UpdateChannel = 'stable' | 'beta'

export interface UpdateStatus {
  currentVersion: string
  channel: UpdateChannel
  checking: boolean
  available: boolean
  latestVersion?: string
  url: string
  error?: string
  /** How far the download has got, 0 to 100, while one is running. */
  downloadPercent?: number
  /** Downloaded and staged. The next quit applies it — there is nothing left
   *  to do but stop using the old one. */
  ready?: boolean
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
  checkoutPath: string
  checkouts: Array<{
    path: string
    branch?: string
    main: boolean
  }>
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
  BrowseRegister: 'browse:register',
  BrowseUnregister: 'browse:unregister',
  BrowseAgentActivity: 'browse:agent-activity',
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
  ProjectList: 'project:list',
  ProjectForget: 'project:forget',
  ProjectReorder: 'project:reorder',
  TerminalCreate: 'terminal:create',
  TerminalWrite: 'terminal:write',
  TerminalResize: 'terminal:resize',
  TerminalDispose: 'terminal:dispose',
  TerminalAck: 'terminal:ack',
  TerminalReady: 'terminal:ready',
  ClipboardRead: 'clipboard:read',
  ClipboardWrite: 'clipboard:write',
  TerminalData: 'terminal:data',
  TerminalExit: 'terminal:exit',
  GitRun: 'git:run',
  ReviewSnapshot: 'review:snapshot',
  ReviewChangeRequestDiff: 'review:change-request-diff',
  ReviewLocalAdd: 'review:local-add',
  ReviewLocalDelete: 'review:local-delete',
  ReviewPublishComment: 'review:publish-comment',
  ReviewReply: 'review:reply',
  ReviewSubmit: 'review:submit',
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
  SitesCfClear: 'sites:cf:clear',
  /** A menu item the renderer acts on. The menu knows what it is called; the
   *  renderer knows how to do it. */
  MenuCommand: 'menu:command',
  UpdateStatusGet: 'update:status',
  UpdateCheck: 'update:check',
  UpdateRestart: 'update:restart',
  UpdateChannelSet: 'update:channel-set',
  UpdateChanged: 'update:changed'
} as const

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels]

/** What a menu item asks the renderer to do. Anything the menu can trigger has
 *  a button somewhere too — the menu is a second way to reach it, not a second
 *  implementation of it. */
export type MenuCommand =
  | 'thread.new'
  | 'thread.new-global'
  | 'view.new'
  | 'tab.close'
  | 'settings.open'
  | 'pane.split-horizontal'
  | 'pane.split-vertical'
