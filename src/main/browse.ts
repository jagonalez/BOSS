import { BrowserWindow, WebContentsView, session, shell, type Session } from 'electron'
import type { BrowseBounds, BrowseNavigationState } from '@shared/ipc'
import type { AgentToolResult } from '@shared/qa'

const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write'])

function isHttpUrl(url: string): boolean {
  return /^https?:/i.test(url)
}

interface BrowseView {
  view: WebContentsView
  loadedOnce: boolean
  state: BrowseNavigationState
  /** Where the view belongs while it is parked off-screen. */
  parked?: { x: number; y: number; width: number; height: number }
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
    return session.fromPartition('persist:boss-browse')
  }

  attach(id: string, bounds: BrowseBounds): void {
    let entry = this.views.get(id)
    if (!entry) {
      entry = this.createView(id)
      this.views.set(id, entry)
    }
    if (entry.parked) entry.parked = bounds
    else entry.view.setBounds(bounds)
    this.win.contentView.addChildView(entry.view)
    // addChildView resets this, and a parked view must stay parked — the
    // renderer states which it wants right after, and unparking is a bounds
    // change rather than a flag.
    entry.view.setVisible(true)

    // Load when there is nothing loaded, not merely the first time. A view is
    // detached and re-attached whenever its pane is hidden, a menu opens over
    // it, or a drag crosses it — and coming back with loadedOnce already true
    // left the page blank at the right bounds, with the url bar still filled
    // in. Asking the web contents what it is showing survives all of that.
    const showing = entry.view.webContents.getURL()
    const wanted = entry.state.url
    if (wanted && !entry.view.webContents.isLoading() && (!showing || showing === 'about:blank')) {
      entry.loadedOnce = true
      void entry.view.webContents.loadURL(wanted)
    }
  }

  detach(id: string): void {
    const entry = this.views.get(id)
    if (entry) {
      this.win.contentView.removeChildView(entry.view)
    }
  }

  /** Move a view out of sight rather than hiding it.
   *
   *  setVisible(false) releases the compositing surface, and rebuilding it on
   *  the way back took a second or more — long enough that a drag looked
   *  broken. Parking the view off-screen keeps it composited, so coming back
   *  is a bounds change and paints immediately. */
  setVisible(id: string, visible: boolean): void {
    const entry = this.views.get(id)
    if (!entry) return
    if (visible) {
      if (entry.parked) {
        entry.view.setBounds(entry.parked)
        entry.parked = undefined
      }
      return
    }
    if (entry.parked) return
    const bounds = entry.view.getBounds()
    entry.parked = bounds
    entry.view.setBounds({ ...bounds, x: -Math.abs(bounds.width) - 4000, y: bounds.y })
  }

  setBounds(id: string, bounds: BrowseBounds): void {
    const entry = this.views.get(id)
    if (!entry) return
    // While parked, remember where it should land rather than dragging it back
    // on screen: the renderer keeps reporting real bounds throughout.
    if (entry.parked) entry.parked = bounds
    else entry.view.setBounds(bounds)
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
    entry.loadedOnce = true
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

  agentTabs(): Array<{ id: string; url: string; title: string; loading: boolean }> {
    return [...this.views.entries()].map(([id, entry]) => ({
      id,
      url: entry.state.url,
      title: entry.state.title,
      loading: entry.state.loading
    }))
  }

  async agentNavigate(id: string, url: string): Promise<AgentToolResult> {
    const entry = this.requireView(id)
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('BOSS browser tools only allow HTTP and HTTPS URLs.')
    }
    entry.loadedOnce = true
    await entry.view.webContents.loadURL(parsed.toString())
    return this.textResult(`Opened ${parsed.toString()} in browser tab ${id}.`)
  }

  async agentSnapshot(id: string): Promise<AgentToolResult> {
    const entry = this.requireView(id)
    const snapshot = await entry.view.webContents.executeJavaScript(`(() => {
      const visible = (element) => {
        const style = getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0
      }
      const label = (element) => {
        const labelledBy = element.getAttribute('aria-labelledby')
        const labelled = labelledBy ? labelledBy.split(/\\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ') : ''
        return (element.getAttribute('aria-label') || labelled || element.getAttribute('alt') || element.getAttribute('title') || element.getAttribute('placeholder') || element.textContent || element.value || '').replace(/\\s+/g, ' ').trim().slice(0, 180)
      }
      const selector = 'a,button,input,textarea,select,summary,[role="button"],[role="link"],[role="checkbox"],[role="tab"],[contenteditable="true"],[tabindex]:not([tabindex="-1"])'
      const elements = [...document.querySelectorAll(selector)].filter(visible).slice(0, 250).map((element, index) => {
        const ref = 'e' + (index + 1)
        element.setAttribute('data-boss-agent-ref', ref)
        const rect = element.getBoundingClientRect()
        return {
          ref,
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute('role') || '',
          name: label(element),
          type: element.getAttribute('type') || '',
          disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true'),
          bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
        }
      })
      return {
        url: location.href,
        title: document.title,
        text: (document.body?.innerText || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 18000),
        elements
      }
    })()`)
    return this.textResult(JSON.stringify(snapshot, null, 2))
  }

  async agentClick(id: string, ref: string): Promise<AgentToolResult> {
    const entry = this.requireView(id)
    const result = await entry.view.webContents.executeJavaScript(`(() => {
      const ref = ${JSON.stringify(ref)}
      const element = [...document.querySelectorAll('[data-boss-agent-ref]')].find((item) => item.getAttribute('data-boss-agent-ref') === ref)
      if (!element) return { ok: false, error: 'Element ref not found. Take a fresh snapshot.' }
      if (element.disabled || element.getAttribute('aria-disabled') === 'true') return { ok: false, error: 'Element is disabled.' }
      element.scrollIntoView({ block: 'center', inline: 'center' })
      element.focus()
      element.click()
      return { ok: true, ref }
    })()`)
    if (!(result as { ok?: boolean }).ok) throw new Error(String((result as { error?: string }).error ?? 'Browser click failed.'))
    return this.textResult(`Clicked ${ref} in browser tab ${id}. Take a fresh snapshot to verify the result.`)
  }

  async agentType(id: string, ref: string, text: string, submit = false): Promise<AgentToolResult> {
    const entry = this.requireView(id)
    if (text.length > 8_000) throw new Error('Browser typing is limited to 8,000 characters per call.')
    const result = await entry.view.webContents.executeJavaScript(`(() => {
      const ref = ${JSON.stringify(ref)}
      const text = ${JSON.stringify(text)}
      const submit = ${JSON.stringify(submit)}
      const element = [...document.querySelectorAll('[data-boss-agent-ref]')].find((item) => item.getAttribute('data-boss-agent-ref') === ref)
      if (!element) return { ok: false, error: 'Element ref not found. Take a fresh snapshot.' }
      element.scrollIntoView({ block: 'center', inline: 'center' })
      element.focus()
      if (element.isContentEditable) {
        element.textContent = text
      } else if ('value' in element) {
        const proto = Object.getPrototypeOf(element)
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
        if (setter) setter.call(element, text)
        else element.value = text
      } else {
        return { ok: false, error: 'Element is not editable.' }
      }
      element.dispatchEvent(new Event('input', { bubbles: true }))
      element.dispatchEvent(new Event('change', { bubbles: true }))
      if (submit) {
        element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }))
        element.closest('form')?.requestSubmit()
        element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }))
      }
      return { ok: true, ref }
    })()`)
    if (!(result as { ok?: boolean }).ok) throw new Error(String((result as { error?: string }).error ?? 'Browser typing failed.'))
    return this.textResult(`Typed into ${ref} in browser tab ${id}${submit ? ' and submitted' : ''}. Take a fresh snapshot to verify the result.`)
  }

  async agentScreenshot(id: string): Promise<AgentToolResult> {
    const entry = this.requireView(id)
    const image = await entry.view.webContents.capturePage(undefined, { stayHidden: true, stayAwake: false })
    const size = image.getSize()
    return {
      __bossToolResult: true,
      text: `Screenshot of browser tab ${id} (${size.width}×${size.height}).`,
      image: { mimeType: 'image/png', data: image.toPNG().toString('base64') }
    }
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

  private requireView(id: string): BrowseView {
    const entry = this.views.get(id)
    if (!entry) throw new Error(`Browser tab ${id || '(missing)'} was not found. Use boss_browser_tabs first.`)
    return entry
  }

  private textResult(text: string): AgentToolResult {
    return { __bossToolResult: true, text }
  }

  private createView(id: string): BrowseView {
    const view = new WebContentsView({
      webPreferences: {
        partition: 'persist:boss-browse',
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
