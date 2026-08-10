import React, { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useStore, appStore } from '../state/AppState'

const THEME = {
  background: '#0b0d10',
  foreground: '#f2f4f8',
  cursor: '#4f8cff',
  cursorAccent: '#0b0d10',
  selectionBackground: 'rgba(79,140,255,0.3)',
  black: '#0b0d10',
  red: '#f85149',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#4f8cff',
  magenta: '#8957e5',
  cyan: '#2dd4bf',
  white: '#f2f4f8',
  brightBlack: '#7d8590',
  brightRed: '#ff7b72',
  brightGreen: '#56d364',
  brightYellow: '#e3b341',
  brightBlue: '#6ba1ff',
  brightMagenta: '#b58cff',
  brightCyan: '#5eead4',
  brightWhite: '#ffffff'
}

export function TerminalTab(): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const projectPath = useStore(appStore, (s) => s.projectPath)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const term = new Terminal({
      fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.35,
      cursorBlink: true,
      theme: THEME,
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
      if (evt.id === termId) term.write(`\r\n\x1b[90m[process exited: ${evt.code}]\x1b[0m\r\n`)
    })

    term.onData((data) => {
      if (termId) window.ralf.terminalWrite(termId, data)
    })

    const initial = fit.proposeDimensions()
    void window.ralf
      .terminalCreate(projectPath || undefined, initial?.cols ?? 80, initial?.rows ?? 24)
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

    return () => {
      cancelled = true
      clearTimeout(focusTimer)
      ro.disconnect()
      window.removeEventListener('resize', fitNow)
      offData()
      offExit()
      if (termId) window.ralf.terminalDispose(termId)
      term.dispose()
    }
  }, [projectPath])

  return <div className="terminal-view" ref={containerRef} />
}
