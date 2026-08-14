import React, { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useStore, appStore } from '../state/AppState'
import type { BackendId } from '@shared/backend'
import { getXtermTheme } from '../lib/themes'
import { terminalSessions } from '../lib/terminal-sessions'

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
        scrollback: 5000
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      existing = { term, fit, ptyId: null, onExit }
      terminalSessions.set(tabId, existing)

      term.onData((data) => {
        const current = terminalSessions.get(tabId)
        if (current?.ptyId) window.boss.terminalWrite(current.ptyId, data)
      })
    }
    const live = existing

    // open() only works once — calling it again on a live terminal does not
    // move it, and leaves it rendering nowhere. Adopting the element it
    // already built moves the whole terminal, buffer and all.
    if (live.term.element) {
      if (live.term.element.parentElement !== el) el.appendChild(live.term.element)
    } else {
      live.term.open(el)
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
      if (evt.id === live.ptyId) live.term.write(evt.data)
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
