import { spawn, type IPty } from 'node-pty'
import { app } from 'electron'
import { existsSync } from 'node:fs'

interface TermSession {
  pty: IPty
}

export class PTYManager {
  private sessions = new Map<string, TermSession>()

  onData?: (id: string, data: string) => void
  onExit?: (id: string, exitCode: number) => void

  create(cwd: string | undefined, cols: number, rows: number): string {
    const id = `term-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const dir = cwd && existsSync(cwd) ? cwd : app.getPath('home')
    const shell = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh')
    const pty = spawn(shell, [], {
      name: 'xterm-256color',
      cols: Math.max(cols, 20),
      rows: Math.max(rows, 5),
      cwd: dir,
      env: process.env as Record<string, string>
    })
    pty.onData((data) => this.onData?.(id, data))
    pty.onExit(({ exitCode }) => this.onExit?.(id, exitCode))
    this.sessions.set(id, { pty })
    return id
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    this.sessions.get(id)?.pty.resize(Math.max(cols, 20), Math.max(rows, 5))
  }

  dispose(id: string): void {
    const session = this.sessions.get(id)
    if (session) {
      try {
        session.pty.kill()
      } catch {
        /* already dead */
      }
      this.sessions.delete(id)
    }
  }

  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) this.dispose(id)
  }
}
