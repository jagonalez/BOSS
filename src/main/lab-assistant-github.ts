import { execFile } from 'node:child_process'
import type { GitHubDelivery } from '../shared/automation-trigger'
import type {
  LabAssistantCiConclusion,
  LabAssistantCiJob,
  LabAssistantMergeability,
  LabAssistantPullRequest
} from '../shared/lab-assistant'

interface GhPullRequest {
  number?: unknown
  title?: unknown
  url?: unknown
  headRefName?: unknown
  baseRefName?: unknown
  mergeable?: unknown
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function integer(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0
}

const FAILURE_CONCLUSIONS = new Set(['failure', 'timed_out', 'action_required', 'startup_failure'])

export interface GitHubWorkflowRunObservation {
  id: string
  repository: string
  workflowId: number
  workflow: string
  runId: number
  runNumber: number
  runAttempt: number
  url: string
  headBranch: string
  headSha: string
  pullRequestId?: string
  conclusion: LabAssistantCiConclusion
  deliveryKey: string
  observedAt: number
}

/** Read only completed GitHub Actions runs that either failed in an actionable
 * way or recovered a prior failure. Cancelled/neutral/skipped runs do not say
 * the implementation is broken and therefore do not page an agent. */
export function workflowRunFromDelivery(
  delivery: GitHubDelivery,
  now = Date.now()
): GitHubWorkflowRunObservation | undefined {
  if (delivery.event !== 'workflow_run' || delivery.action !== 'completed') return undefined
  const run = record(delivery.body.workflow_run)
  const repository = text(record(delivery.body.repository).full_name)
  const workflowId = integer(run.workflow_id)
  const runId = integer(run.id)
  const runNumber = integer(run.run_number)
  const runAttempt = integer(run.run_attempt) || 1
  const workflow = text(run.name)
  const url = text(run.html_url)
  const headBranch = text(run.head_branch)
  const headSha = text(run.head_sha)
  const rawConclusion = text(run.conclusion).toLowerCase()
  const conclusion = rawConclusion === 'success'
    ? 'success'
    : FAILURE_CONCLUSIONS.has(rawConclusion) ? rawConclusion as LabAssistantCiConclusion : undefined
  if (!repository || !workflowId || !runId || !runNumber || !workflow || !url || !headBranch || !headSha || !conclusion) {
    return undefined
  }
  const pullRequests = Array.isArray(run.pull_requests) ? run.pull_requests : []
  const pullRequestNumber = integer(record(pullRequests[0]).number)
  return {
    id: `${repository}:workflow:${workflowId}:${headBranch}`,
    repository,
    workflowId,
    workflow,
    runId,
    runNumber,
    runAttempt,
    url,
    headBranch,
    headSha,
    ...(pullRequestNumber ? { pullRequestId: `${repository}#${pullRequestNumber}` } : {}),
    conclusion,
    deliveryKey: `${runId}:${runAttempt}:${conclusion}`,
    observedAt: now
  }
}

export function parseGitHubWorkflowJobs(raw: string): LabAssistantCiJob[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const jobs = Array.isArray(parsed) ? parsed : record(parsed).jobs
  if (!Array.isArray(jobs)) return []
  return jobs.flatMap((value) => {
    const job = record(value)
    const conclusion = text(job.conclusion).toLowerCase()
    if (!FAILURE_CONCLUSIONS.has(conclusion)) return []
    const name = text(job.name)
    if (!name) return []
    const steps = Array.isArray(job.steps) ? job.steps : []
    return [{
      name,
      url: text(job.html_url),
      conclusion,
      failedSteps: steps
        .filter((step) => FAILURE_CONCLUSIONS.has(text(record(step).conclusion).toLowerCase()))
        .map((step) => text(record(step).name))
        .filter(Boolean)
    }]
  })
}

export function parseGitHubPullRequests(raw: string, repository: string, now = Date.now()): LabAssistantPullRequest[] {
  let values: unknown
  try {
    values = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(values)) return []
  return values.flatMap((value) => {
    if (typeof value !== 'object' || value === null) return []
    const pullRequest = value as GhPullRequest
    const number = typeof pullRequest.number === 'number' ? pullRequest.number : Number(pullRequest.number)
    const headBranch = text(pullRequest.headRefName)
    const baseBranch = text(pullRequest.baseRefName)
    if (!Number.isInteger(number) || number <= 0 || !headBranch || !baseBranch) return []
    const ghMergeability = text(pullRequest.mergeable).toUpperCase()
    const mergeability: LabAssistantMergeability = ghMergeability === 'CONFLICTING'
      ? 'conflicted'
      : ghMergeability === 'MERGEABLE' ? 'clean' : 'unknown'
    return [{
      id: `${repository}#${number}`,
      repository,
      number,
      title: text(pullRequest.title) || `Pull request #${number}`,
      url: text(pullRequest.url),
      headBranch,
      baseBranch,
      state: 'open' as const,
      mergeability,
      updatedAt: now
    }]
  })
}

export function listGitHubPullRequests(repository: string): Promise<LabAssistantPullRequest[]> {
  return new Promise((resolve, reject) => {
    execFile('gh', [
      'pr', 'list',
      '--repo', repository,
      '--state', 'open',
      '--limit', '100',
      '--json', 'number,title,url,headRefName,baseRefName,mergeable'
    ], { encoding: 'utf8', timeout: 20_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(String(stderr || error.message).trim() || 'GitHub pull request refresh failed.'))
        return
      }
      resolve(parseGitHubPullRequests(stdout, repository))
    })
  })
}

/** Fetch failed jobs for one exact run attempt. Reruns reuse the run id, so
 * the attempt belongs in the endpoint or an old failure can be sent as new. */
export function inspectGitHubWorkflowRun(
  repository: string,
  runId: number,
  attempt: number
): Promise<LabAssistantCiJob[]> {
  return new Promise((resolve, reject) => {
    execFile('gh', [
      'api',
      `repos/${repository}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`
    ], { encoding: 'utf8', timeout: 20_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(String(stderr || error.message).trim() || 'GitHub workflow inspection failed.'))
        return
      }
      resolve(parseGitHubWorkflowJobs(stdout))
    })
  })
}
