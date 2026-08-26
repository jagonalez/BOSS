import type { GitHubDelivery } from './automation-trigger'
import { branchFromRef } from './automation-trigger'
import type { BossEvent } from './workflow'

/**
 * Normalize authenticated GitHub webhook deliveries into workflow events.
 * Pure, so the wiring in main stays a shell. Every delivery that reaches the
 * hook endpoint is published — subscriptions narrow by type and data filters
 * (repo, branch, prNumber, author, …), not by which automation the delivery
 * was addressed to.
 */

function str(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function repoName(body: Record<string, unknown>): string {
  return str(record(body.repository).full_name)
}

function sender(body: Record<string, unknown>): string {
  return str(record(body.sender).login)
}

/**
 * Map a GitHub delivery to a BossEvent, or null for events we do not
 * normalize. Types follow `github.<event>` with the payload's discriminating
 * fields flattened into `data` for subscription filters.
 */
export function githubDeliveryEvent(delivery: GitHubDelivery, id: string, at: number): BossEvent | null {
  const body = delivery.body
  const base: Record<string, unknown> = {
    repo: repoName(body),
    sender: sender(body),
    ...(delivery.action ? { action: delivery.action } : {})
  }
  switch (delivery.event) {
    case 'push': {
      return {
        id,
        type: 'github.push',
        at,
        data: { ...base, branch: branchFromRef(str(body.ref)), ref: str(body.ref) }
      }
    }
    case 'pull_request': {
      const pr = record(body.pull_request)
      return {
        id,
        type: 'github.pull_request',
        at,
        data: {
          ...base,
          prNumber: num(body.number) ?? num(pr.number) ?? '',
          title: str(pr.title),
          author: str(record(pr.user).login),
          headBranch: str(record(pr.head).ref),
          baseBranch: str(record(pr.base).ref),
          url: str(pr.html_url),
          merged: record(pr).merged === true,
          draft: record(pr).draft === true
        }
      }
    }
    case 'pull_request_review': {
      const pr = record(body.pull_request)
      const review = record(body.review)
      return {
        id,
        type: 'github.pull_request_review',
        at,
        data: {
          ...base,
          prNumber: num(pr.number) ?? '',
          author: str(record(review.user).login),
          state: str(review.state),
          body: str(review.body),
          url: str(review.html_url),
          headBranch: str(record(pr.head).ref)
        }
      }
    }
    case 'pull_request_review_comment': {
      const pr = record(body.pull_request)
      const comment = record(body.comment)
      return {
        id,
        type: 'github.pull_request_review_comment',
        at,
        data: {
          ...base,
          prNumber: num(pr.number) ?? '',
          author: str(record(comment.user).login),
          body: str(comment.body),
          path: str(comment.path),
          url: str(comment.html_url),
          headBranch: str(record(pr.head).ref)
        }
      }
    }
    case 'issue_comment': {
      const issue = record(body.issue)
      const comment = record(body.comment)
      return {
        id,
        type: 'github.issue_comment',
        at,
        data: {
          ...base,
          issueNumber: num(issue.number) ?? '',
          isPullRequest: 'pull_request' in issue,
          author: str(record(comment.user).login),
          body: str(comment.body),
          url: str(comment.html_url)
        }
      }
    }
    case 'workflow_run': {
      const run = record(body.workflow_run)
      return {
        id,
        type: 'github.workflow_run',
        at,
        data: {
          ...base,
          name: str(run.name),
          status: str(run.status),
          conclusion: str(run.conclusion),
          branch: str(run.head_branch),
          runId: num(run.id) ?? '',
          attempt: num(run.run_attempt) ?? '',
          url: str(run.html_url)
        }
      }
    }
    case 'check_suite': {
      const suite = record(body.check_suite)
      return {
        id,
        type: 'github.check_suite',
        at,
        data: {
          ...base,
          status: str(suite.status),
          conclusion: str(suite.conclusion),
          branch: str(suite.head_branch)
        }
      }
    }
    default:
      return null
  }
}
