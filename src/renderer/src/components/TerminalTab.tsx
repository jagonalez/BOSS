import React, { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { WebglAddon } from '@xterm/addon-webgl'
import { useStore, appStore } from '../state/AppState'
import type { BackendId } from '@shared/backend'
import { getXtermTheme } from '../lib/themes'
import { terminalSessions } from '../lib/terminal-sessions'
import { attachClipboard } from '../lib/terminal-clipboard'

export function TerminalTab({
  tabId,
  authBackendId,
  contextPath,
  onExit
}: {
  tabId: string
  authBackendId?: BackendId
  contextPath?: string
  onExit?: (code: number) => void
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const projectPath = useStore(appStore, (s) => s.projectPath)
  const cwd = contextPath || projectPath

  // Kept on the session so the exit handler always calls the current one
  // without the listener having to be rebound.
  const session = terminalSessions.get(tabId)
  if (session) session.onExit = onExit

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    let existing = terminalSessions.get(tabId)
    if (!existing) {
      const term = new Terminal({
        fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
        fontSize: 13,
        lineHeight: 1.35,
        cursorBlink: true,
        theme: getXtermTheme(),
        scrollback: 5000,
        // Lifts theme colours that land too close to the background until they
        // are legible. Without it a shell prompt using dim ANSI colours can be
        // nearly invisible against some of our themes.
        minimumContrastRatio: 4.5,
        // Matches macOS terminals, where right-click selects the word under
        // the pointer rather than leaving the selection untouched.
        rightClickSelectsWord: true,
        smoothScrollDuration: 125
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      existing = { term, fit, ptyId: null, onExit }
      terminalSessions.set(tabId, existing)

      term.onData((data) => {
        const current = terminalSessions.get(tabId)
        if (current?.ptyId) window.boss.terminalWrite(current.ptyId, data)
      })

      attachClipboard(term)
    }
    const live = existing

    // open() only works once — calling it again on a live terminal does not
    // move it, and leaves it rendering nowhere. Adopting the element it
    // already built moves the whole terminal, buffer and all.
    if (live.term.element) {
      if (live.term.element.parentElement !== el) el.appendChild(live.term.element)
    } else {
      live.term.open(el)
      // The default renderer builds a span per styled run per row, which is
      // what makes a busy terminal feel slow. WebGL draws glyphs from a
      // texture atlas instead. It has to load after open(), and only once.
      try {
        const webgl = new WebglAddon()
        // The context is lost when the GPU resets or the window moves between
        // displays. Disposing drops xterm back to the DOM renderer, which is
        // slower but still correct — far better than a blank terminal.
        webgl.onContextLoss(() => webgl.dispose())
        live.term.loadAddon(webgl)
      } catch {
        /* No WebGL available; the DOM renderer stays in place. */
      }
    }

    const fitNow = (): void => {
      try {
        live.fit.fit()
        const dims = live.fit.proposeDimensions()
        if (live.ptyId && dims) window.boss.terminalResize(live.ptyId, dims.cols, dims.rows)
      } catch {
        /* ignore */
      }
    }

    const offData = window.boss.onTerminalData((evt) => {
      if (evt.id !== live.ptyId) return
      // The callback fires once xterm has parsed this chunk. Reporting it is
      // what lets the shell keep running when it is producing output faster
      // than we can draw; without it the pty stays paused for good.
      live.term.write(evt.data, () => window.boss.terminalAck(evt.id, evt.data.length))
    })
    const offExit = window.boss.onTerminalExit((evt) => {
      if (evt.id !== live.ptyId) return
      live.term.write(`\r\n\x1b[90m[process exited: ${evt.code}]\x1b[0m\r\n`)
      live.onExit?.(evt.code)
    })

    if (!live.ptyId) {
      const initial = live.fit.proposeDimensions()
      void window.boss
        .terminalCreate(cwd || undefined, initial?.cols ?? 80, initial?.rows ?? 24, authBackendId)
        .then((id) => {
          // The tab may have closed while this was in flight, in which case
          // the session is gone and this shell has nobody to belong to.
          if (!terminalSessions.has(tabId)) {
            window.boss.terminalDispose(id)
            return
          }
          live.ptyId = id
          fitNow()
          // The shell has been writing since it spawned, but the data listener
          // above could not match any of it until this id existed. Tell the
          // main process it is safe to send now, or the prompt never arrives.
          window.boss.terminalReady(id)
        })
    } else {
      // After layout: the element has just been moved into this container, so
      // measuring it now would read the size it had in the old pane.
      requestAnimationFrame(fitNow)
    }

    const ro = new ResizeObserver(fitNow)
    ro.observe(el)
    window.addEventListener('resize', fitNow)

    const focusTimer = setTimeout(() => live.term.focus(), 50)
    const onThemeChanged = (): void => {
      live.term.options.theme = getXtermTheme()
    }
    window.addEventListener('boss:theme-changed', onThemeChanged)

    // No dispose here. Unmounting means React moved this tab, which is
    // routine; the shell is disposed when the tab closes.
    return () => {
      clearTimeout(focusTimer)
      ro.disconnect()
      window.removeEventListener('resize', fitNow)
      window.removeEventListener('boss:theme-changed', onThemeChanged)
      offData()
      offExit()
    }
  }, [tabId, cwd, authBackendId])

  return <div className="terminal-view" ref={containerRef} />
}
