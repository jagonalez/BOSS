import { app } from 'electron'
import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater
import type { UpdateStatus } from '@shared/ipc'

const REPO = 'jagonalez/ralf'
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`

export class UpdateChecker {
  private cached: UpdateStatus
  private onChange?: (status: UpdateStatus) => void
  private wired = false

  constructor() {
    this.cached = { currentVersion: app.getVersion(), checking: false, available: false, url: RELEASES_PAGE }
  }

  status(): UpdateStatus {
    return this.cached
  }

  /** Told when a download progresses or finishes, since those arrive on their
   *  own rather than in answer to a check. */
  subscribe(listener: (status: UpdateStatus) => void): void {
    this.onChange = listener
  }

  private publish(patch: Partial<UpdateStatus>): void {
    this.cached = { ...this.cached, ...patch }
    this.onChange?.(this.cached)
  }

  /** Downloads in the background and applies on quit.
   *
   *  Nothing is installed while the app runs: an agent may be mid-task, and
   *  swapping the binary underneath it to save a restart is a poor trade. */
  private wire(): void {
    if (this.wired) return
    this.wired = true
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('update-available', (info) => {
      this.publish({ available: true, latestVersion: info.version, checking: false })
    })
    autoUpdater.on('update-not-available', () => {
      this.publish({ available: false, checking: false })
    })
    autoUpdater.on('download-progress', (progress) => {
      this.publish({ downloadPercent: Math.round(progress.percent) })
    })
    autoUpdater.on('update-downloaded', (info) => {
      this.publish({ available: true, ready: true, downloadPercent: 100, latestVersion: info.version })
    })
    autoUpdater.on('error', (error) => {
      // Reported, not thrown. A failed update check is not a reason to
      // interrupt someone, and the app works perfectly well unupdated.
      this.publish({ checking: false, error: error instanceof Error ? error.message : String(error) })
    })
  }

  /** Apply a staged update now rather than at the next quit.
   *
   *  Only when one is staged: quitting to install nothing would just close the
   *  app on someone who asked for an update. */
  restart(): void {
    if (!this.cached.ready) return
    autoUpdater.quitAndInstall()
  }

  async check(): Promise<UpdateStatus> {
    const currentVersion = app.getVersion()
    this.publish({ currentVersion, checking: true, error: undefined })
    // Only a packaged build can replace itself. In development there is no
    // installer to apply and electron-updater says so with an error, which
    // would show as a failure every launch.
    if (!app.isPackaged) {
      this.publish({ checking: false, available: false })
      return this.cached
    }
    this.wire()
    try {
      await autoUpdater.checkForUpdates()
    } catch (error) {
      this.publish({ checking: false, error: error instanceof Error ? error.message : String(error) })
    }
    return this.cached
  }
}
