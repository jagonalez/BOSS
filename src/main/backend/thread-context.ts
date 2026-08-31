/** What a thread should be told about where it is working. */
export interface ThreadContext {
  projectName?: string
  projectPath?: string
  /** The directory the agent actually runs in. Differs from projectPath when
   *  the thread has a worktree. */
  executionPath?: string
  branch?: string
  worktree?: boolean
}

/** Tell the agent which project and checkout it is in.
 *
 *  Without this an agent works it out: it reads the directory it happens to be
 *  in, and for anything the directory does not say — which repository, which
 *  branch — it looks at whatever else is in front of it. One asked about a
 *  browser tab and guessed from that, which is right only by luck.
 *
 *  Returns an empty string when there is nothing worth saying, so a chat with
 *  no project does not get a paragraph explaining that it has no project.
 *
 *  Every backend takes standing instructions, by its own route: claude and pi
 *  append to their own, codex takes them per turn, opencode takes them on the
 *  prompt, and lab owns the whole thing. Pi is the exception in one way — it is
 *  started once per conversation, so what it is given at the start is what it
 *  keeps.
 *
 *  A room sends much more this way: what an agent's role is, what it missed,
 *  and what has changed on disk. All of it used to travel as a message, which
 *  the user saw as a wall of text they never wrote. */
export function threadContextPrompt(context: ThreadContext): string {
  const lines: string[] = []
  if (context.projectName) lines.push(`You are working in the ${context.projectName} project.`)
  const directory = context.executionPath || context.projectPath
  if (directory) lines.push(`Its files are at ${directory}.`)
  if (context.worktree && context.branch) {
    // Worth stating plainly: a worktree is a second checkout of the same
    // repository, and an agent that misses this reasons about the wrong one.
    lines.push(`This is a Git worktree on the ${context.branch} branch, not the main checkout.`)
  } else if (context.branch) {
    lines.push(`It is on the ${context.branch} branch.`)
  }
  if (!lines.length) return ''
  lines.push('Take this as given rather than working it out, and say so if you need to act outside it.')
  return lines.join(' ')
}
