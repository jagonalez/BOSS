import { session, shell, webContents, type Session, type WebContents } from 'electron'
import type { BrowseNavigationState } from '@shared/ipc'
import type { AgentToolResult } from '@shared/qa'

const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write'])
export const BROWSE_PARTITION = 'persist:boss-browse'

function isHttpUrl(url: string): boolean {
  return /^https?:/i.test(url)
}

interface BrowseView {
  wc: WebContents
  state: BrowseNavigationState
}

/** Tracks the browser panes, which the renderer owns.
 *
 *  They used to be WebContentsViews the main process created and positioned:
 *  outside the DOM, composited above the page, with bounds to keep in sync on
 *  every layout change. In a tiling workspace that fought everything — a menu
 *  drew underneath, a drag across one swallowed the events, and moving a tab
 *  between panes meant parking, repainting and re-measuring.
 *
 *  A <webview> is a DOM element, so the renderer places it with CSS like any
 *  other pane content. This keeps a registry of their web contents so agent
 *  tools still reach the page directly, without a hop through the renderer. */
export class BrowseManager {
  private views = new Map<string, BrowseView>()

  onNavigation?: (id: string, state: BrowseNavigationState) => void
  onExternal?: (url: string) => void

  constructor() {
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
    return session.fromPartition(BROWSE_PARTITION)
  }

  /** Take ownership of a webview the renderer has attached.
   *
   *  The renderer creates the element and hands over its web contents id once
   *  the guest is ready, which is the one thing it cannot do from the DOM. */
  register(id: string, webContentsId: number): void {
    const wc = webContents.fromId(webContentsId)
    if (!wc) return
    const existing = this.views.get(id)
    if (existing?.wc === wc) return

    const entry: BrowseView = {
      wc,
      state: existing?.state ?? { url: '', title: '', canGoBack: false, canGoForward: false, loading: false }
    }
    this.views.set(id, entry)
    this.wire(id, entry)
  }

  unregister(id: string): void {
    this.views.delete(id)
  }

  navigate(id: string, url: string): void {
    const entry = this.views.get(id)
    if (!entry) return
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return
    void entry.wc.loadURL(url)
  }

  goBack(id: string): void {
    this.views.get(id)?.wc.navigationHistory.goBack()
  }

  goForward(id: string): void {
    this.views.get(id)?.wc.navigationHistory.goForward()
  }

  reload(id: string): void {
    this.views.get(id)?.wc.reload()
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
    await entry.wc.loadURL(parsed.toString())
    return this.textResult(`Opened ${parsed.toString()} in browser tab ${id}.`)
  }

  async agentSnapshot(id: string): Promise<AgentToolResult> {
    const entry = this.requireView(id)
    const snapshot = await entry.wc.executeJavaScript(`(() => {
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
    const result = await entry.wc.executeJavaScript(`(() => {
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
    const result = await entry.wc.executeJavaScript(`(() => {
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
    const image = await entry.wc.capturePage(undefined, { stayHidden: true, stayAwake: false })
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
    this.views.delete(id)
    // The renderer owns the element, so removing it from the DOM is what ends
    // the guest. Closing here as well covers a tab closed while its pane is
    // not mounted, and is harmless when the element has already gone.
    if (!entry.wc.isDestroyed()) entry.wc.close()
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

  /** Listen to a guest page the renderer has handed over. The webview element
   *  carries the sandbox settings; this is only about watching it. */
  private wire(id: string, entry: BrowseView): void {
    const wc = entry.wc

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
    // The element can go away without the tab closing — a pane unmounting, a
    // reload during development — and a stale entry would have agent tools
    // talking to a dead page.
    wc.on('destroyed', () => {
      if (this.views.get(id)?.wc === wc) this.views.delete(id)
    })

    if (wc.getURL()) update({ url: wc.getURL(), title: wc.getTitle() })
  }
}
