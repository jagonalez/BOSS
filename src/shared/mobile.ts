import type { BackendRequest } from './backend'

export type MobileAccessRole = 'control' | 'read-only'

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
