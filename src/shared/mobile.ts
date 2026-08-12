export interface MobileAccessConfig {
  enabled: boolean
  /** Fixed port so tailscale serve rules survive restarts. */
  port: number
  token: string
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
