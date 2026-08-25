import type { BackendRequest } from './backend'

export type MobileAccessRole = 'control' | 'read-only'
export type MobileTransport = 'local' | 'relay'

/** Requests exposed by both mobile transports. Keep this at the transport
 * boundary: the native client can connect through either one, so a request
 * available over only one path is a device-dependent failure. */
const LOCAL_REQUESTS = new Set<BackendRequest['type']>([
  'backend.list',
  'supervision.snapshot',
  'supervision.search',
  'supervision.acknowledge',
  'thread.list',
  'thread.get',
  'thread.messages',
  'thread.part',
  'thread.send',
  'thread.followups.list',
  'thread.followups.add',
  'thread.followups.update',
  'thread.followups.remove',
  'thread.followups.move',
  'thread.followups.steer',
  'thread.abort',
  'thread.todos',
  'thread.permission',
  'thread.diff',
  'automation.list',
  'automation.run',
  'automation.stop',
  'assistant.snapshot',
  'assistant.answer',
  'assistant.task.create',
  'assistant.task.update',
  'assistant.task.assign'
])

/** Pairing is a control-only relationship, so it also exposes the thread
 * lifecycle actions used by the native app. Local token access stays narrower. */
const RELAY_REQUESTS = new Set<BackendRequest['type']>([
  ...LOCAL_REQUESTS,
  'thread.create',
  'thread.models',
  'thread.mode.set',
  'thread.archive',
  'thread.delegate',
  'thread.rename',
  'thread.delete'
])

export function mobileTransportRequestAllowed(type: BackendRequest['type'], transport: MobileTransport): boolean {
  return (transport === 'relay' ? RELAY_REQUESTS : LOCAL_REQUESTS).has(type)
}

const READ_ONLY_REQUESTS = new Set<BackendRequest['type']>([
  'backend.list',
  'supervision.snapshot',
  'supervision.search',
  'thread.list',
  'thread.get',
  'thread.messages',
  'thread.part',
  'thread.todos',
  'thread.followups.list',
  'thread.diff',
  'automation.list',
  'report.list',
  'report.get',
  'assistant.snapshot'
])

export function mobileRequestAllowed(type: BackendRequest['type'], role: MobileAccessRole): boolean {
  return role === 'control' || READ_ONLY_REQUESTS.has(type)
}

export interface MobileAccessConfig {
  enabled: boolean
  /** Fixed port so tailscale serve rules survive restarts. */
  port: number
  token: string
  /** Separate credential that can inspect tasks but cannot send, stop, approve, or run anything. */
  viewerToken: string
  /** Run `tailscale serve` automatically so the site is reachable on the tailnet. */
  tailscale: boolean
}

export interface MobileAccessStatus extends MobileAccessConfig {
  running: boolean
  /** Loopback URL of the mobile site, when running. */
  url?: string
  error?: string
  /** HTTPS URL on the tailnet when tailscale serve succeeded. */
  tailscaleUrl?: string
  tailscaleError?: string
}
