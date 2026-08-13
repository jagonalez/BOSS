import { execFile } from 'node:child_process'
import type {
  AddReviewCommentInput,
  ChangeRequestFileDiff,
  ChangeRequestSummary,
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
}

export function runCommand(command: string, args: string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        code: error ? Number((error as NodeJS.ErrnoException).code) || 1 : 0,
        stdout: String(stdout),
        stderr: String(stderr)
      })
    })
  })
}

export async function requiredCommand(command: string, args: string[], cwd: string): Promise<string> {
  const result = await runCommand(command, args, cwd)
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `${command} ${args[0]} failed`)
  return result.stdout
}
