import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'

export interface TerminalSession {
  term: Terminal
  fit: FitAddon
  /** Null until terminalCreate resolves. */
  ptyId: string | null
  onExit?: (code: number) => void
}

/** Live terminals, keyed by the tab that owns them.
 *
 *  Both halves have to outlive the component. The pty holds the shell and
 *  xterm holds the scrollback, so creating either inside an effect meant a
 *  remount started a new shell with an empty screen. React remounts a tab
 *  whenever it moves between panes, and StrictMode remounts everything once in
 *  development, so a terminal used to reset on every drag.
 *
 *  Lives here rather than beside the component so the close actions can reach
 *  it without importing a component. */
export const terminalSessions = new Map<string, TerminalSession>()

export function disposeTerminalSession(tabId: string): void {
  const session = terminalSessions.get(tabId)
  if (!session) return
  terminalSessions.delete(tabId)
  if (session.ptyId) window.boss.terminalDispose(session.ptyId)
  session.term.dispose()
}
