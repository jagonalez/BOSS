import { BrowserWindow, WebContentsView, session, shell, type Session } from 'electron'
import type { BrowseBounds, BrowseNavigationState } from '@shared/ipc'

const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write'])

function isHttpUrl(url: string): boolean {
  return /^https?:/i.test(url)
}

interface BrowseView {
  view: WebContentsView
  loadedOnce: boolean
  state: BrowseNavigationState
}

export class BrowseManager {
  private views = new Map<string, BrowseView>()

  onNavigation?: (id: string, state: BrowseNavigationState) => void
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

  attach(id: string, bounds: BrowseBounds): void {
    let entry = this.views.get(id)
    if (!entry) {
      entry = this.createView(id)
      this.views.set(id, entry)
    }
    entry.view.setBounds(bounds)
    this.win.contentView.addChildView(entry.view)
    if (!entry.loadedOnce && entry.state.url && !entry.view.webContents.isLoading()) {
      entry.loadedOnce = true
      void entry.view.webContents.loadURL(entry.state.url)
    }
  }

  detach(id: string): void {
    const entry = this.views.get(id)
    if (entry) {
      this.win.contentView.removeChildView(entry.view)
    }
  }

  setBounds(id: string, bounds: BrowseBounds): void {
    const entry = this.views.get(id)
    if (entry) entry.view.setBounds(bounds)
  }

  navigate(id: string, url: string): void {
    let entry = this.views.get(id)
    if (!entry) {
      entry = this.createView(id)
      this.views.set(id, entry)
    }
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return
    void entry.view.webContents.loadURL(url)
  }

  goBack(id: string): void {
    this.views.get(id)?.view.webContents.navigationHistory.goBack()
  }

  goForward(id: string): void {
    this.views.get(id)?.view.webContents.navigationHistory.goForward()
  }

  reload(id: string): void {
    this.views.get(id)?.view.webContents.reload()
  }

  destroy(id: string): void {
    const entry = this.views.get(id)
    if (!entry) return
    this.win.contentView.removeChildView(entry.view)
    entry.view.webContents.close()
    this.views.delete(id)
  }

  destroyAll(): void {
    for (const id of [...this.views.keys()]) this.destroy(id)
  }

  private createView(id: string): BrowseView {
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
    const entry: BrowseView = {
      view,
      loadedOnce: false,
      state: { url: '', title: '', canGoBack: false, canGoForward: false, loading: false }
    }

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

    const update = (partial: Partial<BrowseNavigationState>): void => {
      entry.state = {
        ...entry.state,
        ...partial,
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward()
      }
      this.onNavigation?.(id, entry.state)
    }

    wc.on('did-start-loading', () => update({ loading: true }))
    wc.on('did-stop-loading', () => update({ loading: false }))
    wc.on('did-navigate', (_e, url) => update({ url }))
    wc.on('did-navigate-in-page', (_e, url) => update({ url }))
    wc.on('page-title-updated', (_e, title) => update({ title }))

    return entry
  }
}
