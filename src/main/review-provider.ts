import { execFile } from 'node:child_process'
import type {
  AddReviewCommentInput,
  ChangeRequestFileDiff,
  ChangeRequestSummary,
  CreateChangeRequestInput,
  CreatedChangeRequest,
  ReviewProviderSummary,
  SubmitReviewEvent
} from '@shared/review'

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

export interface ReviewRepository {
  root: string
  branch: string
  remoteUrl?: string
}

export interface ReviewProviderMatch {
  repository: string
}

export interface ReviewProvider {
  readonly summary: ReviewProviderSummary
  match(remoteUrl: string): ReviewProviderMatch | undefined
  getChangeRequest(repository: ReviewRepository, match: ReviewProviderMatch): Promise<ChangeRequestSummary>
  getCanonicalDiff?(repository: ReviewRepository, match: ReviewProviderMatch, changeRequest: ChangeRequestSummary): Promise<ChangeRequestFileDiff[]>
  publishComment?(repository: ReviewRepository, match: ReviewProviderMatch, changeRequest: ChangeRequestSummary, input: AddReviewCommentInput): Promise<void>
  replyToComment?(repository: ReviewRepository, match: ReviewProviderMatch, changeRequest: ChangeRequestSummary, commentId: string, body: string): Promise<void>
  submitVerdict?(repository: ReviewRepository, match: ReviewProviderMatch, changeRequest: ChangeRequestSummary, event: SubmitReviewEvent, body: string): Promise<void>
  /** Open a change request for the repository's current branch. */
  createChangeRequest?(repository: ReviewRepository, match: ReviewProviderMatch, input: CreateChangeRequestInput): Promise<CreatedChangeRequest>
  /** Publish the already-committed current branch using the provider's host
   *  authentication. This avoids depending on an agent shell's SSH keys. */
  publishBranch?(repository: ReviewRepository, match: ReviewProviderMatch): Promise<void>
  /** The branch a change request targets when the caller does not name one. */
  getDefaultBranch?(repository: ReviewRepository, match: ReviewProviderMatch): Promise<string | undefined>
}

/**
 * Run a command and collect what it wrote.
 *
 * `stdin` is for text a flag cannot safely carry: a change request body is arbitrary prose, and
 * both forge CLIs read one from standard input rather than an argument. Nothing is spawned through
 * a shell, so the text is never interpreted; passing it this way also keeps a long body clear of
 * the operating system's argument-length ceiling.
 */
export function runCommand(command: string, args: string[], cwd: string, stdin?: string): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = execFile(command, args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        code: error ? Number((error as NodeJS.ErrnoException).code) || 1 : 0,
        stdout: String(stdout),
        stderr: String(stderr)
      })
    })
    if (stdin === undefined) return
    // A command that exits before reading closes the pipe under us; that shows up in its exit
    // code, so the write failing is not itself the error worth reporting.
    child.stdin?.on('error', () => {})
    child.stdin?.end(stdin)
  })
}

/**
 * The first URL a forge CLI printed. Both `gh` and `glab` answer a create with the address of what
 * they opened, sometimes after a line of their own chatter, so the URL is picked out rather than
 * assumed to be the whole of the output.
 */
export function firstUrl(value: string): string | undefined {
  return /https?:\/\/\S+/.exec(value)?.[0].replace(/[.,)\]]+$/, '')
}

/** The number a change request URL ends in, for the forges that put it there. */
export function changeRequestNumberFromUrl(url: string): number | undefined {
  const match = /\/(?:pull|merge_requests)\/(\d+)(?:[/?#]|$)/.exec(url)
  const value = match ? Number(match[1]) : Number.NaN
  return Number.isInteger(value) && value > 0 ? value : undefined
}

export async function requiredCommand(command: string, args: string[], cwd: string, stdin?: string): Promise<string> {
  const result = await runCommand(command, args, cwd, stdin)
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `${command} ${args[0]} failed`)
  return result.stdout
}
