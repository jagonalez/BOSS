import { execFile } from 'node:child_process'
import type { LabAssistantMergeability, LabAssistantPullRequest } from '../shared/lab-assistant'

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
