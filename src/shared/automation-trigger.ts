import type { AutomationWebhookTrigger } from './automation'

/**
 * Pure GitHub-webhook logic for automation triggers: which deliveries fire an
 * automation, and how a delivery maps into prompt variables. No I/O, so the
 * HTTP endpoint in main stays a thin shell around these functions.
 */

/** Per-value ceiling so one huge payload cannot flood the prompt. */
const MAX_VARIABLE_LENGTH = 2_000

/** Pull-request actions that count as "a PR was opened". Anything else
 *  (synchronize, closed, labeled…) is repo noise no one asked to be woken for. */
export const PULL_REQUEST_ACTIONS = ['opened', 'reopened'] as const

export const AUTOMATION_WEBHOOK_EVENTS = ['push', 'pull_request'] as const

export interface GitHubDelivery {
  /** The `x-github-event` header value, e.g. 'push' or 'pull_request'. */
  event: string
  /** The payload's `action`, e.g. 'opened'. Absent for pushes. */
  action?: string
  body: Record<string, unknown>
}

export function parseGitHubDelivery(eventHeader: string | undefined, body: unknown): GitHubDelivery | null {
  if (!eventHeader) return null
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const action = (body as { action?: unknown }).action
  return {
    event: String(eventHeader).trim(),
    action: typeof action === 'string' ? action : undefined,
    body: body as Record<string, unknown>
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
}

/** refs/heads/main → main; anything else passes through untouched. */
export function branchFromRef(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
}

function repoName(body: Record<string, unknown>): string {
  const repo = body.repository
  return repo && typeof repo === 'object' ? str((repo as { full_name?: unknown }).full_name) : ''
}

function senderName(body: Record<string, unknown>): string {
  const sender = body.sender
  return sender && typeof sender === 'object' ? str((sender as { login?: unknown }).login) : ''
}

function pullRequest(body: Record<string, unknown>): Record<string, unknown> {
  const pr = body.pull_request
  return pr && typeof pr === 'object' ? pr as Record<string, unknown> : {}
}

/** Whether this delivery may fire the given trigger. Unsupported GitHub events
 *  never match — the endpoint exists for pushes and pull requests only. */
export function webhookTriggerMatches(
  trigger: AutomationWebhookTrigger | null | undefined,
  delivery: GitHubDelivery
): boolean {
  if (!trigger) return false
  if (delivery.event === 'push') {
    if (!wantsEvent(trigger.events, 'push')) return false
    return branchMatches(deliveryBranch(delivery), trigger.branch)
  }
  if (delivery.event === 'pull_request') {
    if (!PULL_REQUEST_ACTIONS.includes(delivery.action as typeof PULL_REQUEST_ACTIONS[number])) return false
    if (!wantsEvent(trigger.events, 'pull_request')) return false
    // A PR run is about work proposed against the base branch.
    const base = (pullRequest(delivery.body).base ?? {}) as { ref?: unknown }
    return branchMatches(str(base.ref), trigger.branch)
  }
  return false
}

function wantsEvent(events: AutomationWebhookEvent[], event: AutomationWebhookEvent): boolean {
  return events.length === 0 || events.includes(event)
}

function branchMatches(actual: string, wanted?: string): boolean {
  if (!wanted) return true
  return actual === wanted
}

function deliveryBranch(delivery: GitHubDelivery): string {
  return branchFromRef(str(delivery.body.ref))
}

/** Flat variables a delivery exposes to the prompt via `{{name}}`. */
export function githubPayloadVariables(delivery: GitHubDelivery): Record<string, string> {
  const vars: Record<string, string> = {
    event: delivery.event,
    action: delivery.action ?? '',
    repo: repoName(delivery.body),
    sender: senderName(delivery.body)
  }
  if (delivery.event === 'push') {
    vars.branch = deliveryBranch(delivery)
    vars.ref = str(delivery.body.ref)
    vars.pusher = str(delivery.body.pusher ? (delivery.body.pusher as { name?: unknown }).name : '')
    const commits = Array.isArray(delivery.body.commits) ? delivery.body.commits : []
    vars.commit_count = String(commits.length)
    vars.commit_messages = commits
      .map((commit) => str((commit as { message?: unknown })?.message).split('\n')[0])
      .filter(Boolean)
      .join('\n')
    vars.head_message = str((commits[commits.length - 1] as { message?: unknown } | undefined)?.message).split('\n')[0]
  }
  if (delivery.event === 'pull_request') {
    const pr = pullRequest(delivery.body)
    const head = (pr.head ?? {}) as { ref?: unknown }
    const base = (pr.base ?? {}) as { ref?: unknown }
    // GitHub puts the number on the envelope, not inside pull_request.
    vars.pr_number = String(typeof delivery.body.number === 'number' ? delivery.body.number : '')
    vars.pr_title = str(pr.title)
    vars.pr_body = str(pr.body)
    vars.pr_author = senderName(delivery.body)
    vars.pr_branch = str(head.ref)
    vars.pr_base_branch = str(base.ref)
    vars.pr_url = str(pr.html_url)
  }
  return vars
}

/** Replace `{{name}}` placeholders with delivery variables. Unknown names are
 *  left in place, so a typo is visible instead of silently empty. */
export function templatePrompt(prompt: string, vars: Record<string, string>): string {
  return prompt.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (placeholder, name: string) => {
    const value = vars[name]
    return value === undefined ? placeholder : capLength(value)
  })
}

function capLength(value: string): string {
  return value.length > MAX_VARIABLE_LENGTH ? `${value.slice(0, MAX_VARIABLE_LENGTH)}…` : value
}

/** One-line description of a delivery for cards and run history. */
export function describeWebhookDelivery(delivery: GitHubDelivery): string {
  const repo = repoName(delivery.body)
  const parts = [delivery.event]
  if (delivery.event === 'push') parts.push(branchFromRef(str(delivery.body.ref)))
  if (delivery.event === 'pull_request') {
    if (typeof delivery.body.number === 'number') parts.push(`#${String(delivery.body.number)}`)
    if (delivery.action) parts.push(delivery.action)
  }
  if (repo) parts.push(repo)
  return parts.filter(Boolean).join(' · ')
}

export type AutomationWebhookEvent = (typeof AUTOMATION_WEBHOOK_EVENTS)[number]

/** True when the value is one of the events BOSS can receive. Used by both the
 *  editor and the manager's input normalization. */
export function isWebhookEvent(value: unknown): value is AutomationWebhookEvent {
  return (AUTOMATION_WEBHOOK_EVENTS as readonly unknown[]).includes(value)
}
