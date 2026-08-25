import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Node's type-stripping test runner needs the extension.
import { parseGitHubPullRequests, parseGitHubWorkflowJobs, workflowRunFromDelivery } from './lab-assistant-github.ts'

test('GitHub PR refresh data maps to authoritative assistant observations', () => {
  const pullRequests = parseGitHubPullRequests(JSON.stringify([
    {
      number: 22,
      title: 'Dependent change',
      url: 'https://github.com/jagonalez/BOSS/pull/22',
      headRefName: 'feature-22',
      baseRefName: 'main',
      mergeable: 'CONFLICTING'
    },
    {
      number: 23,
      title: 'Independent change',
      url: 'https://github.com/jagonalez/BOSS/pull/23',
      headRefName: 'feature-23',
      baseRefName: 'main',
      mergeable: 'MERGEABLE'
    }
  ]), 'jagonalez/BOSS', 123)
  assert.equal(pullRequests.length, 2)
  assert.equal(pullRequests[0].mergeability, 'conflicted')
  assert.equal(pullRequests[1].mergeability, 'clean')
  assert.equal(pullRequests[0].updatedAt, 123)
})

test('malformed GitHub PR refresh data is ignored', () => {
  assert.deepEqual(parseGitHubPullRequests('not json', 'jagonalez/BOSS'), [])
  assert.deepEqual(parseGitHubPullRequests('[{"number":1}]', 'jagonalez/BOSS'), [])
})

test('completed workflow deliveries retain rerun identity and pull request ownership', () => {
  const observation = workflowRunFromDelivery({
    event: 'workflow_run',
    action: 'completed',
    body: {
      action: 'completed',
      repository: { full_name: 'jagonalez/BOSS' },
      workflow_run: {
        id: 801,
        workflow_id: 42,
        run_number: 19,
        run_attempt: 2,
        name: 'CI',
        html_url: 'https://github.com/jagonalez/BOSS/actions/runs/801',
        head_branch: 'feature-ci',
        head_sha: 'abc123',
        status: 'completed',
        conclusion: 'failure',
        pull_requests: [{ number: 31 }]
      }
    }
  }, 123)

  assert.deepEqual(observation, {
    id: 'jagonalez/BOSS:workflow:42:feature-ci',
    repository: 'jagonalez/BOSS',
    workflowId: 42,
    workflow: 'CI',
    runId: 801,
    runNumber: 19,
    runAttempt: 2,
    url: 'https://github.com/jagonalez/BOSS/actions/runs/801',
    headBranch: 'feature-ci',
    headSha: 'abc123',
    pullRequestId: 'jagonalez/BOSS#31',
    conclusion: 'failure',
    deliveryKey: '801:2:failure',
    observedAt: 123
  })
})

test('workflow monitoring ignores incomplete and non-actionable conclusions', () => {
  const delivery = {
    event: 'workflow_run',
    action: 'completed',
    body: {
      repository: { full_name: 'jagonalez/BOSS' },
      workflow_run: {
        id: 801, workflow_id: 42, run_number: 19, name: 'CI',
        html_url: 'https://example.test/run', head_branch: 'main', head_sha: 'abc',
        conclusion: 'cancelled'
      }
    }
  }
  assert.equal(workflowRunFromDelivery(delivery), undefined)
  assert.equal(workflowRunFromDelivery({ ...delivery, action: 'requested' }), undefined)
})

test('workflow jobs keep only actionable failures and their failed steps', () => {
  assert.deepEqual(parseGitHubWorkflowJobs(JSON.stringify({ jobs: [
    {
      name: 'check', conclusion: 'success', html_url: 'https://example.test/check',
      steps: [{ name: 'npm test', conclusion: 'success' }]
    },
    {
      name: 'Electron end-to-end', conclusion: 'failure', html_url: 'https://example.test/e2e',
      steps: [
        { name: 'Set up job', conclusion: 'success' },
        { name: 'Run npm run test:e2e', conclusion: 'failure' }
      ]
    }
  ] })), [{
    name: 'Electron end-to-end',
    url: 'https://example.test/e2e',
    conclusion: 'failure',
    failedSteps: ['Run npm run test:e2e']
  }])
  assert.deepEqual(parseGitHubWorkflowJobs('not json'), [])
})
