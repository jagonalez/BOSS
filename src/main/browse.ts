import { BrowserWindow, WebContentsView, session, shell, type Session } from 'electron'
import type { BrowseBounds, BrowseNavigationState } from '@shared/ipc'

const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write'])

function isHttpUrl(url: string): boolean {
  return /^https?:/i.test(url)
}

export class BrowseManager {
  private view: WebContentsView | null = null
  private attached = false
  private state: BrowseNavigationState = {
    url: '',
    title: '',
    canGoBack: false,
    canGoForward: false,
    loading: false
  }

  onNavigation?: (state: BrowseNavigationState) => void
  onExternal?: (url: string) => void

  constructor(private readonly win: BrowserWindow) {
    this.hardenSession()
  }

  private hardenSession(): void {
    const ses = this.browseSession()
    ses.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(ALLOWED_PERMISSIONS.has(permission))
    })
    ses.setPermissionCheckHandler((_wc, permission) => {
      return ALLOWED_PERMISSIONS.has(permission)
    })
  }

  private browseSession(): Session {
    return session.fromPartition('persist:ralf-browse')
  }

  attach(bounds: BrowseBounds): void {
    if (!this.view) this.createView()
    const view = this.view!
    view.setBounds(bounds)
    this.win.contentView.addChildView(view)
    this.attached = true
    if (this.state.url && !view.webContents.isLoading()) {
      void view.webContents.loadURL(this.state.url)
    }
  }

  detach(): void {
    if (this.view && this.attached) {
      this.win.contentView.removeChildView(this.view)
      this.attached = false
    }
  }

  setBounds(bounds: BrowseBounds): void {
    if (this.view && this.attached) this.view.setBounds(bounds)
  }

  navigate(url: string): void {
    if (!this.view) return
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return
    void this.view.webContents.loadURL(url)
  }

  goBack(): void {
    this.view?.webContents.navigationHistory.goBack()
  }

  goForward(): void {
    this.view?.webContents.navigationHistory.goForward()
  }

  reload(): void {
    this.view?.webContents.reload()
  }

  private createView(): void {
    const view = new WebContentsView({
      webPreferences: {
        partition: 'persist:ralf-browse',
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        webSecurity: true,
        spellcheck: true
      }
    })
    const wc = view.webContents

    wc.setWindowOpenHandler(({ url }) => {
      if (isHttpUrl(url)) void shell.openExternal(url)
      this.onExternal?.(url)
      return { action: 'deny' }
    })

    wc.on('will-navigate', (event, url) => {
      if (isHttpUrl(url)) return
      event.preventDefault()
      if (url.startsWith('file:')) {
        this.onExternal?.(url)
      }
    })

    wc.on('will-attach-webview', (event) => {
      event.preventDefault()
    })

    wc.on('did-start-loading', () => this.updateState({ loading: true }))
    wc.on('did-stop-loading', () => this.updateState({ loading: false }))
    wc.on('did-navigate', (_e, url) => this.updateState({ url }))
    wc.on('did-navigate-in-page', (_e, url) => this.updateState({ url }))
    wc.on('page-title-updated', (_e, title) => this.updateState({ title }))

    this.view = view
    this.updateState({})
  }

  private updateState(partial: Partial<BrowseNavigationState>): void {
    const wc = this.view?.webContents
    this.state = {
      ...this.state,
      ...partial,
      canGoBack: wc?.navigationHistory.canGoBack() ?? false,
      canGoForward: wc?.navigationHistory.canGoForward() ?? false
    }
    this.onNavigation?.(this.state)
  }
}
