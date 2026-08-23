import assert from 'node:assert/strict'
import test from 'node:test'

// Node's type-stripping test runner requires explicit extensions.
// @ts-expect-error Application code uses bundler resolution.
import { branchFromRef, describeWebhookDelivery, githubPayloadVariables, isWebhookEvent, parseGitHubDelivery, templatePrompt, webhookTriggerMatches } from './automation-trigger.ts'
import type { AutomationWebhookTrigger } from './automation'

function pushBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ref: 'refs/heads/main',
    repository: { full_name: 'octo/hello' },
    sender: { login: 'octocat' },
    pusher: { name: 'octocat' },
    commits: [
      { message: 'fix the bug\ngithub: closes #1' },
      { message: 'add a test' }
    ],
    ...overrides
  }
}

function prBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'opened',
    number: 14,
    repository: { full_name: 'octo/hello' },
    sender: { login: 'octocat' },
    pull_request: {
      title: 'Add webhook triggers',
      body: 'Fires automations from GitHub.',
      html_url: 'https://github.com/octo/hello/pull/14',
      head: { ref: 'feature/hooks' },
      base: { ref: 'main' }
    },
    ...overrides
  }
}

const anyBranch = (events?: AutomationWebhookTrigger['events']): AutomationWebhookTrigger => ({
  events: events ?? [],
  branch: ''
})

test('a push delivery matches a trigger that wants pushes', () => {
  const delivery = parseGitHubDelivery('push', pushBody())
  assert.ok(delivery)
  assert.equal(webhookTriggerMatches(anyBranch(['push']), delivery), true)
})

test('an empty event filter means every supported event', () => {
  const delivery = parseGitHubDelivery('push', pushBody())!
  assert.equal(webhookTriggerMatches(anyBranch(), delivery), true)
})

test('a push is ignored when the trigger only wants pull requests', () => {
  const delivery = parseGitHubDelivery('push', pushBody())!
  assert.equal(webhookTriggerMatches(anyBranch(['pull_request']), delivery), false)
})

test('a pull request opened matches, but synchronize does not', () => {
  const trigger = anyBranch(['pull_request'])
  assert.equal(webhookTriggerMatches(trigger, parseGitHubDelivery('pull_request', prBody())!), true)
  assert.equal(
    webhookTriggerMatches(trigger, parseGitHubDelivery('pull_request', prBody({ action: 'synchronize' }))!),
    false
  )
  assert.equal(
    webhookTriggerMatches(trigger, parseGitHubDelivery('pull_request', prBody({ action: 'closed' }))!),
    false
  )
  assert.equal(webhookTriggerMatches(trigger, parseGitHubDelivery('pull_request', prBody({ action: 'reopened' }))!), true)
})

test('a branch filter applies to the pushed branch and to the PR base branch', () => {
  const push = parseGitHubDelivery('push', pushBody({ ref: 'refs/heads/dev' }))!
  const prAgainstMain = parseGitHubDelivery('pull_request', prBody())!
  const prAgainstDev = parseGitHubDelivery('pull_request', prBody({
    pull_request: { head: { ref: 'x' }, base: { ref: 'dev' } }
  }))!
  const devOnly: AutomationWebhookTrigger = { events: [], branch: 'dev' }
  assert.equal(webhookTriggerMatches(devOnly, push), true)
  assert.equal(webhookTriggerMatches(devOnly, prAgainstDev), true)
  assert.equal(webhookTriggerMatches(devOnly, prAgainstMain), false)
})

test('unsupported GitHub events never fire an automation', () => {
  const delivery = parseGitHubDelivery('issues', { action: 'opened' })
  assert.ok(delivery)
  assert.equal(webhookTriggerMatches(anyBranch(), delivery), false)
})

test('a delivery without an event header or with a non-object body parses to null', () => {
  assert.equal(parseGitHubDelivery(undefined, pushBody()), null)
  assert.equal(parseGitHubDelivery('push', '[1,2]'), null)
  assert.equal(parseGitHubDelivery('push', 'nope'), null)
})

test('push payloads expose branch, pusher, and commit variables', () => {
  const vars = githubPayloadVariables(parseGitHubDelivery('push', pushBody())!)
  assert.equal(vars.event, 'push')
  assert.equal(vars.repo, 'octo/hello')
  assert.equal(vars.sender, 'octocat')
  assert.equal(vars.branch, 'main')
  assert.equal(vars.pusher, 'octocat')
  assert.equal(vars.commit_count, '2')
  assert.equal(vars.commit_messages, 'fix the bug\nadd a test')
  assert.equal(vars.head_message, 'add a test')
})

test('pull request payloads expose title, branches, and url', () => {
  const vars = githubPayloadVariables(parseGitHubDelivery('pull_request', prBody())!)
  assert.equal(vars.event, 'pull_request')
  assert.equal(vars.action, 'opened')
  assert.equal(vars.pr_number, '14')
  assert.equal(vars.pr_title, 'Add webhook triggers')
  assert.equal(vars.pr_branch, 'feature/hooks')
  assert.equal(vars.pr_base_branch, 'main')
  assert.equal(vars.pr_url, 'https://github.com/octo/hello/pull/14')
  assert.equal(vars.pr_author, 'octocat')
})

test('templating replaces known placeholders and leaves unknown ones visible', () => {
  const prompt = 'Review {{pr_title}} ({{event}} on {{branch}}) for {{unknownvar}} end'
  const vars = githubPayloadVariables(parseGitHubDelivery('pull_request', prBody())!)
  vars.branch = 'main'
  assert.equal(
    templatePrompt(prompt, vars),
    'Review Add webhook triggers (pull_request on main) for {{unknownvar}} end'
  )
})

test('templating tolerates whitespace in placeholders and caps huge values', () => {
  assert.equal(templatePrompt('{{ repo }}/{{ event }}', { repo: 'octo/hello', event: 'push' }), 'octo/hello/push')
  const huge = 'x'.repeat(3_000)
  const rendered = templatePrompt('{{commit_messages}}', { commit_messages: huge })
  assert.equal(rendered.length, 2_001)
  assert.ok(rendered.endsWith('…'))
})

test('delivery descriptions name the event, branch or PR, and repository', () => {
  assert.equal(describeWebhookDelivery(parseGitHubDelivery('push', pushBody())!), 'push · main · octo/hello')
  assert.equal(
    describeWebhookDelivery(parseGitHubDelivery('pull_request', prBody())!),
    'pull_request · #14 · opened · octo/hello'
  )
})

test('refs are reduced to branch names', () => {
  assert.equal(branchFromRef('refs/heads/feature/x'), 'feature/x')
  assert.equal(branchFromRef('refs/tags/v1'), 'refs/tags/v1')
  assert.equal(branchFromRef('main'), 'main')
})

test('isWebhookEvent accepts exactly the supported events', () => {
  assert.equal(isWebhookEvent('push'), true)
  assert.equal(isWebhookEvent('pull_request'), true)
  assert.equal(isWebhookEvent('issues'), false)
  assert.equal(isWebhookEvent(''), false)
})
