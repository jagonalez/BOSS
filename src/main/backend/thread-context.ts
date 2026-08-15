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
 *  Used by the backends that take a system prompt per message: claude through
 *  --append-system-prompt, codex through a turn's developerInstructions.
 *  OpenCode and pi have no such hook, and both are already told their working
 *  directory, so they are left alone rather than given an invented field. */
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
