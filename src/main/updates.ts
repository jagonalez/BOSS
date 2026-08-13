import { app } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import type { UpdateStatus } from '@shared/ipc'
import { isNewer } from '@shared/version'

const execFileAsync = promisify(execFile)

const REPO = 'jagonalez/boss'
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`

// A packaged macOS app does not inherit the shell PATH, so `gh` must be located
// by absolute path the way tailscaleBin() does in web-access.ts.
function ghBin(): string | null {
  for (const candidate of ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh']) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

// The repo is private, so the releases API needs credentials. Reading them from
// the gh CLI at call time keeps the token out of the shipped bundle, where
// anyone with the app could extract it.
async function ghToken(): Promise<string | null> {
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (fromEnv) return fromEnv
  const bin = ghBin()
  if (!bin) return null
  try {
    const { stdout } = await execFileAsync(bin, ['auth', 'token'], { timeout: 5000 })
    const token = stdout.trim()
    return token || null
  } catch {
    return null
  }
}

export class UpdateChecker {
  private cached: UpdateStatus

  constructor() {
    this.cached = { currentVersion: app.getVersion(), checking: false, available: false, url: RELEASES_PAGE }
  }

  status(): UpdateStatus {
    return this.cached
  }

  async check(): Promise<UpdateStatus> {
    const currentVersion = app.getVersion()
    this.cached = { ...this.cached, currentVersion, checking: true, error: undefined }
    const token = await ghToken()
    if (!token) {
      // No credentials on this machine. Staying quiet beats nagging the user
      // about a check they never asked for.
      this.cached = { currentVersion, checking: false, available: false, url: RELEASES_PAGE }
      return this.cached
    }
    try {
      const res = await fetch(API_URL, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'boss-update-check'
        },
        signal: AbortSignal.timeout(10_000)
      })
      if (!res.ok) throw new Error(`GitHub responded ${res.status}`)
      const body = (await res.json()) as { tag_name?: string; html_url?: string; name?: string }
      const tag = body.tag_name ?? ''
      const latestVersion = tag.replace(/^v/, '')
      const available = Boolean(latestVersion) && isNewer(latestVersion, currentVersion)
      this.cached = {
        currentVersion,
        checking: false,
        available,
        latestVersion: latestVersion || undefined,
        url: body.html_url || RELEASES_PAGE
      }
    } catch (error) {
      this.cached = {
        currentVersion,
        checking: false,
        available: false,
        url: RELEASES_PAGE,
        error: error instanceof Error ? error.message : String(error)
      }
    }
    return this.cached
  }
}
