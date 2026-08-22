import type {
  ChangeRequestSummary,
  CreateChangeRequestInput,
  CreatedChangeRequest
} from '@shared/review'
// The explicit extension keeps the source executable under Node's type-stripping test runner.
import type { ReviewProvider, ReviewProviderMatch, ReviewRepository } from './review-provider.ts'
// @ts-expect-error Application builds use bundler resolution.
import { changeRequestNumberFromUrl, firstUrl, requiredCommand, runCommand } from './review-provider.ts'

/**
 * GitLab, reached through `glab` when it is installed and the REST API when it is not.
 *
 * The CLI is preferred because it already holds the user's credentials, so nothing has to be
 * stored here. The API path exists because glab is not bundled and most machines will not have it;
 * it reads a token from the environment, the same names glab itself reads.
 */

/** The token names glab reads, in the order it reads them. */
const TOKEN_VARIABLES = ['GITLAB_TOKEN', 'GITLAB_ACCESS_TOKEN', 'CI_JOB_TOKEN'] as const

export interface GitLabLocator {
  /** Everything after the host: a group, any subgroups, and the project. */
  project: string
  /** The API root for the instance the remote names, so self-hosted GitLab works too. */
  origin: string
}

export function parseGitLabRemote(remote: string): GitLabLocator | undefined {
  const trimmed = remote.trim().replace(/\.git$/, '')
  const ssh = /^(?:git@|ssh:\/\/git@)([^/:]+)[:/](.+)$/i.exec(trimmed)
  const https = /^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/i.exec(trimmed)
  const match = ssh ?? https
  if (!match) return undefined
  const [, host, path] = match
  // A project always has an owner and a name; a bare host with one segment is not one. Subgroups
  // make the middle open-ended, so the count is a floor rather than an exact shape.
  if (path.split('/').filter(Boolean).length < 2) return undefined
  // Only gitlab.com is recognised by name. A self-hosted instance is indistinguishable from any
  // other git host by its URL alone, so it is matched by an explicit setting instead of a guess.
  const selfHosted = (process.env.BOSS_GITLAB_HOST ?? '').trim().toLowerCase()
  const known = host.toLowerCase() === 'gitlab.com' || (selfHosted !== '' && host.toLowerCase() === selfHosted)
  if (!known) return undefined
  return { project: path, origin: `https://${host}` }
}

export function gitlabToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const name of TOKEN_VARIABLES) {
    const value = env[name]?.trim()
    if (value) return value
  }
  return undefined
}

/**
 * The `glab mr create` invocation for one request.
 *
 * `--yes` matters more here than the equivalent does for gh: glab asks what to do about the remote
 * branch, and a question asked of a spawned process is a hang rather than an error.
 */
export function createMergeRequestArgs(
  input: CreateChangeRequestInput,
  headBranch: string
): { args: string[]; stdin?: string } {
  const title = input.title?.trim()
  const body = input.body?.trim()
  const args = ['mr', 'create', '--source-branch', headBranch, '--yes']
  if (input.baseBranch) args.push('--target-branch', input.baseBranch)
  if (input.draft) args.push('--draft')
  if (!title && !body) {
    args.push('--fill')
    return { args }
  }
  args.push('--title', title || headBranch)
  // `--description -` means "open an editor", which would hang; the file form is what reads stdin.
  args.push('--description-file', '-')
  return { args, stdin: body ?? '' }
}

export class GitLabReviewProvider implements ReviewProvider {
  readonly summary = {
    id: 'gitlab',
    label: 'GitLab',
    changeRequestLabel: 'Merge request',
    capabilities: {
      canonicalDiff: false,
      publishOverallComment: false,
      publishInlineComment: false,
      replyToComment: false,
      submitVerdict: false,
      createChangeRequest: true
    }
  } as const

  match(remoteUrl: string): ReviewProviderMatch | undefined {
    const locator = parseGitLabRemote(remoteUrl)
    return locator ? { repository: locator.project } : undefined
  }

  /**
   * Reading a merge request is not implemented yet: this provider exists so a branch can be turned
   * into one. Review still runs against GitHub only, and the capability flags above say so.
   */
  async getChangeRequest(): Promise<ChangeRequestSummary> {
    throw new Error('Reading a GitLab merge request is not supported yet.')
  }

  async getDefaultBranch(repository: ReviewRepository, match: ReviewProviderMatch): Promise<string | undefined> {
    if (await this.hasCli(repository.root)) {
      const result = await runCommand('glab', ['repo', 'view', '--output', 'json'], repository.root)
      if (result.code === 0) {
        const branch = readJson(result.stdout)?.default_branch
        if (typeof branch === 'string' && branch) return branch
      }
      return undefined
    }
    const project = await this.api(repository, match, '', 'GET')
    const branch = project?.default_branch
    return typeof branch === 'string' && branch ? branch : undefined
  }

  async createChangeRequest(repository: ReviewRepository, match: ReviewProviderMatch, input: CreateChangeRequestInput): Promise<CreatedChangeRequest> {
    return (await this.hasCli(repository.root))
      ? this.createViaCli(repository, input)
      : this.createViaApi(repository, match, input)
  }

  private async createViaCli(repository: ReviewRepository, input: CreateChangeRequestInput): Promise<CreatedChangeRequest> {
    const { args, stdin } = createMergeRequestArgs(input, repository.branch)
    const stdout = await requiredCommand('glab', args, repository.root, stdin)
    const url = firstUrl(stdout)
    if (!url) throw new Error(stdout.trim() || 'GitLab did not report a merge request URL.')
    const number = changeRequestNumberFromUrl(url)
    return { url, ...(number === undefined ? {} : { number }) }
  }

  private async createViaApi(repository: ReviewRepository, match: ReviewProviderMatch, input: CreateChangeRequestInput): Promise<CreatedChangeRequest> {
    const target = input.baseBranch ?? (await this.getDefaultBranch(repository, match))
    if (!target) throw new Error('Could not determine which branch this merge request should target.')
    const title = input.title?.trim() || repository.branch
    const created = await this.api(repository, match, '/merge_requests', 'POST', {
      source_branch: repository.branch,
      target_branch: target,
      title: input.draft ? `Draft: ${title}` : title,
      description: input.body?.trim() ?? ''
    })
    const url = typeof created?.web_url === 'string' ? created.web_url : undefined
    if (!url) throw new Error('GitLab did not report a merge request URL.')
    const iid = typeof created?.iid === 'number' ? created.iid : changeRequestNumberFromUrl(url)
    return { url, ...(iid === undefined ? {} : { number: iid }) }
  }

  private async hasCli(cwd: string): Promise<boolean> {
    if (this.cliPresent === undefined) {
      const result = await runCommand('glab', ['--version'], cwd)
      this.cliPresent = result.code === 0
    }
    return this.cliPresent
  }

  private cliPresent: boolean | undefined

  private async api(
    repository: ReviewRepository,
    match: ReviewProviderMatch,
    path: string,
    method: 'GET' | 'POST',
    body?: Record<string, unknown>
  ): Promise<Record<string, unknown> | undefined> {
    const token = gitlabToken()
    if (!token) {
      throw new Error(
        'GitLab needs either the glab CLI or a token. Install glab, or set GITLAB_TOKEN in the environment BOSS was started from.'
      )
    }
    const locator = repository.remoteUrl ? parseGitLabRemote(repository.remoteUrl) : undefined
    const origin = locator?.origin ?? 'https://gitlab.com'
    const url = `${origin}/api/v4/projects/${encodeURIComponent(match.repository)}${path}`
    const response = await fetch(url, {
      method,
      headers: {
        'PRIVATE-TOKEN': token,
        ...(body ? { 'content-type': 'application/json' } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    })
    const text = await response.text()
    if (!response.ok) {
      // GitLab explains a rejection in the body; the status alone would not say which branch or
      // field it objected to.
      const detail = readJson(text)?.message ?? (text.trim() || response.statusText)
      throw new Error(`GitLab refused the request (${response.status}): ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
    }
    return readJson(text)
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readJson(value: string): any {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}
