import React, { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useStore, appStore } from '../state/AppState'
import type { BackendId } from '@shared/backend'
import { getXtermTheme } from '../lib/themes'

export function TerminalTab({
  authBackendId,
  contextPath,
  onExit
}: {
  authBackendId?: BackendId
  contextPath?: string
  onExit?: (code: number) => void
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const onExitRef = useRef(onExit)
  const projectPath = useStore(appStore, (s) => s.projectPath)
  const cwd = contextPath || projectPath

  onExitRef.current = onExit

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

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
    term.open(el)

    let termId: string | null = null
    let cancelled = false

    const fitNow = (): void => {
      try {
        fit.fit()
        const dims = fit.proposeDimensions()
        if (termId && dims) window.ralf.terminalResize(termId, dims.cols, dims.rows)
      } catch {
        /* ignore */
      }
    }

    const offData = window.ralf.onTerminalData((evt) => {
      if (evt.id === termId) term.write(evt.data)
    })
    const offExit = window.ralf.onTerminalExit((evt) => {
      if (evt.id !== termId) return
      term.write(`\r\n\x1b[90m[process exited: ${evt.code}]\x1b[0m\r\n`)
      onExitRef.current?.(evt.code)
    })

    term.onData((data) => {
      if (termId) window.ralf.terminalWrite(termId, data)
    })

    const initial = fit.proposeDimensions()
    void window.ralf
      .terminalCreate(cwd || undefined, initial?.cols ?? 80, initial?.rows ?? 24, authBackendId)
      .then((id) => {
        if (cancelled) {
          window.ralf.terminalDispose(id)
          return
        }
        termId = id
        fitNow()
      })

    const ro = new ResizeObserver(fitNow)
    ro.observe(el)
    window.addEventListener('resize', fitNow)

    const focusTimer = setTimeout(() => term.focus(), 50)
    const onThemeChanged = (): void => {
      term.options.theme = getXtermTheme()
    }
    window.addEventListener('ralf:theme-changed', onThemeChanged)

    return () => {
      cancelled = true
      clearTimeout(focusTimer)
      ro.disconnect()
      window.removeEventListener('resize', fitNow)
      window.removeEventListener('ralf:theme-changed', onThemeChanged)
      offData()
      offExit()
      if (termId) window.ralf.terminalDispose(termId)
      term.dispose()
    }
  }, [cwd, authBackendId])

  return <div className="terminal-view" ref={containerRef} />
}
