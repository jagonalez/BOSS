/** Where a thread runs.
 *
 *  Each thread belongs to a project and the manager knows which, so it pushes
 *  that path down on every lookup. A backend that ignored it used one global
 *  path instead — whichever project was selected most recently — so a thread in
 *  one project read, and was given write access to, another.
 *
 *  Its own module because two backends need the same rule and neither can
 *  import the other, and because a plain file with no bundler aliases can be
 *  tested directly. */
export class SessionDirectories {
  private readonly paths = new Map<string, string>()

  /** Ignores an empty path: the manager passes a binding's executionPath, which
   *  is empty while a thread's project is unresolved, and taking it would undo
   *  a good answer. */
  set(sessionId: string, directory: string): void {
    if (directory) this.paths.set(sessionId, directory)
  }

  /** The thread's own checkout, or the current project as a last resort. That
   *  fallback is only right by luck, so it is worth keeping visible. */
  resolve(sessionId: string, fallback: string): string | undefined {
    return this.paths.get(sessionId) || fallback || undefined
  }

  forget(sessionId: string): void {
    this.paths.delete(sessionId)
  }
}
