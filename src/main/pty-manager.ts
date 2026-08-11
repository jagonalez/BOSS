import { spawn, type IPty } from 'node-pty'
import { app } from 'electron'
import { existsSync } from 'node:fs'
import type { BackendId } from '@shared/backend'
import type { BackendAuth } from './backend-auth'

interface TermSession {
  pty: IPty
}

export class PTYManager {
  private sessions = new Map<string, TermSession>()

  onData?: (id: string, data: string) => void
  onExit?: (id: string, exitCode: number) => void

  constructor(private readonly backendAuth?: BackendAuth) {}

  create(cwd: string | undefined, cols: number, rows: number, authBackendId?: BackendId): string {
    const id = `term-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const dir = cwd && existsSync(cwd) ? cwd : app.getPath('home')
    const auth = authBackendId ? this.backendAuth?.launch(authBackendId) : undefined
    const command = auth?.command ?? process.env.SHELL ?? (process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh')
    const pty = spawn(command, auth?.args ?? [], {
      name: 'xterm-256color',
      cols: Math.max(cols, 20),
      rows: Math.max(rows, 5),
      cwd: dir,
      env: process.env as Record<string, string>
    })
    pty.onData((data) => this.onData?.(id, data))
    pty.onExit(({ exitCode }) => this.onExit?.(id, exitCode))
    this.sessions.set(id, { pty })
    if (auth?.initialInput) {
      setTimeout(() => {
        const session = this.sessions.get(id)
        if (!session) return
        const input = auth.initialInput!.replace(/[\r\n]+$/, '')
        session.pty.write(input)
        // Pi switches its terminal into raw mode after rendering startup resources.
        // Submitting before that transition is swallowed by the line discipline,
        // even though the command itself remains visible at the prompt.
        setTimeout(() => this.sessions.get(id)?.pty.write('\r'), 500)
      }, 3_500)
    }
    return id
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return
    this.sessions.get(id)?.pty.resize(Math.max(Math.floor(cols), 20), Math.max(Math.floor(rows), 5))
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
