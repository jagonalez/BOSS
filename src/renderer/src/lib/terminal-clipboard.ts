import type { Terminal } from '@xterm/xterm'
import { appStore } from '../state/AppState'
import { normalizePaste } from './terminal-paste'

/** Copy and paste for the terminal, modelled on VS Code's.
 *
 *  A terminal cannot use the app's normal copy and paste. Cmd+C in a shell
 *  means interrupt, and a paste has to reach the shell as input rather than
 *  land in the DOM. Both keys therefore need handling here, before the browser
 *  or the application menu acts on them.
 *
 *  One deliberate difference from VS Code: copy-on-select is on. VS Code
 *  defaults it off because its terminal is an occasional panel. Here the
 *  terminal sits beside threads and text moves between the two constantly, so
 *  selecting to copy is worth more than it costs. */

/** Ask before pasting text that would run as several commands.
 *
 *  Resolves true to paste. Declining and dismissing are the same answer, so
 *  the promise settles either way and a refused paste leaves nothing pending. */
function confirmMultilinePaste(lineCount: number, preview: string): Promise<boolean> {
  return new Promise((resolve) => {
    appStore.setState({
      confirm: {
        title: 'Paste into terminal',
        message: `This pastes ${lineCount} lines, which the shell will run as ${lineCount} commands.\n\n${preview}`,
        confirmLabel: 'Paste',
        action: () => resolve(true)
      }
    })
    // The modal clears `confirm` on cancel without telling us, so watch the
    // store instead of waiting for a callback that never comes.
    const stop = appStore.subscribe(() => {
      if (appStore.getState().confirm) return
      stop()
      // Runs after the confirm action above when the paste was accepted, and
      // resolving a settled promise again is a no-op, so this is safe either way.
      resolve(false)
    })
  })
}

async function paste(term: Terminal): Promise<void> {
  // No pty check: term.paste() feeds the terminal's own data handler, which
  // sends to the shell once there is one, so there is nothing to guard here.
  const raw = window.boss.clipboardRead()
  if (!raw) return
  const { text, needsConfirm, lineCount } = normalizePaste(raw)
  if (needsConfirm) {
    // Bracketed paste means the shell holds the text at the prompt instead of
    // running each line, so there is nothing to warn about.
    const bracketed = term.modes.bracketedPasteMode
    if (!bracketed) {
      const preview = text.split(/\r?\n/).slice(0, 3).map((line) => line.slice(0, 30)).join('\n')
      if (!(await confirmMultilinePaste(lineCount, preview))) return
    }
  }
  term.paste(text)
}

/** Bind the clipboard keys and copy-on-select to a terminal. */
export function attachClipboard(term: Terminal): void {
  term.onSelectionChange(() => {
    const selection = term.getSelection()
    if (selection) window.boss.clipboardWrite(selection)
  })

  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true

    // Option with a left or right arrow moves by word. macOS treats Option as
    // a compose key, so the browser reports a dead key rather than the arrow
    // and the shell receives nothing; the sequence readline expects is sent
    // here instead. Option+Cmd+Arrow is the pane shortcut, so it is excluded.
    if (event.altKey && !event.metaKey && (event.code === 'ArrowLeft' || event.code === 'ArrowRight')) {
      // Matched on code, not key: with Option held the browser may report a
      // dead key instead of the arrow, so key is not dependable here.
      term.input(event.code === 'ArrowLeft' ? '\x1bb' : '\x1bf')
      event.preventDefault()
      return false
    }

    const mod = event.metaKey || (event.ctrlKey && event.shiftKey)
    if (!mod) return true

    const key = event.key.toLowerCase()
    if (key === 'c' && term.hasSelection()) {
      // Only intercept with a selection. With none, Cmd+C has to reach the
      // shell so it still interrupts whatever is running — the same rule VS
      // Code enforces through the keybinding's `when` clause.
      window.boss.clipboardWrite(term.getSelection())
      term.clearSelection()
      event.preventDefault()
      return false
    }
    if (key === 'v') {
      void paste(term)
      event.preventDefault()
      return false
    }
    if (key === 'k') {
      term.clear()
      event.preventDefault()
      return false
    }

    // Cmd with a left or right arrow jumps to the start or end of the line,
    // which is how you edit a long command. Terminals treat Command as an
    // application modifier and send nothing for it, so the sequences readline
    // expects are sent here instead. Option+Cmd+Arrow stays ours for moving
    // between panes.
    if (!event.altKey && (event.code === 'ArrowLeft' || event.code === 'ArrowRight')) {
      // Home and End, in whichever form the program expects: a shell in
      // application cursor mode reads the SS3 form, everything else the CSI
      // one. Sending the wrong one prints stray characters at the prompt.
      const ss3 = term.modes.applicationCursorKeysMode
      const home = ss3 ? '\x1bOH' : '\x1b[H'
      const end = ss3 ? '\x1bOF' : '\x1b[F'
      term.input(event.code === 'ArrowLeft' ? home : end)
      event.preventDefault()
      return false
    }

    // Everything else held with Command belongs to the app, not the shell.
    // Returning true here would hand the keystroke to xterm, which sends it on
    // and calls preventDefault, so the window shortcuts for switching tabs and
    // moving between panes would never fire while a terminal had focus.
    // Control combinations still fall through: Ctrl+C and friends are the
    // shell's, not ours.
    if (event.metaKey) return false
    return true
  })
}
