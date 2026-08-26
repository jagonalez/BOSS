import { expect, lastBackendCall, test } from './fixtures'

test('the workflows page shows durable runs, pending questions, and the agent-approval state', async ({ appPage }) => {
  await appPage.getByRole('button', { name: 'Workflows' }).click()

  await expect(appPage.locator('.workflows-page')).toBeVisible()
  // Level 1 disambiguates the page title from the list section's h2.
  await expect(appPage.getByRole('heading', { name: 'Workflows', level: 1 })).toBeVisible()

  // The seeded agent-authored workflow is disabled and says so: enabling it is
  // the user's approval step.
  const card = appPage.locator('.automation-card').filter({ hasText: 'Datadog alert watcher' })
  await expect(card).toContainText('Awaiting approval')
  await expect(card).toContainText('Agent-authored')
  await expect(card).toContainText('Cron: */20 * * * *')

  // Its latest run is parked on an ask(): the question is answerable in place.
  await expect(card).toContainText('Waiting on an event, timer, or answer.')
  await expect(card).toContainText('Mute the flaky monitor?')
  const answer = card.locator('.workflow-answer input')
  await answer.fill('yes, mute it')
  await card.getByRole('button', { name: 'Answer' }).click()
  const answered = await lastBackendCall(appPage, 'workflow.run.answer')
  expect(answered.request).toEqual({
    type: 'workflow.run.answer',
    runId: 'workflow-run-seed',
    seq: 1,
    response: 'yes, mute it'
  })

  // Enabling is a plain update the engine treats as approval.
  await card.getByRole('button', { name: 'Enable' }).click()
  const enabled = await lastBackendCall(appPage, 'workflow.update')
  expect(enabled.request).toEqual({ type: 'workflow.update', workflowId: 'workflow-watcher-seed', patch: { enabled: true } })
})

test('creating a workflow sends the script, triggers, and budget to the engine', async ({ appPage }) => {
  await appPage.getByRole('button', { name: 'Workflows' }).click()
  await appPage.getByRole('button', { name: 'New workflow' }).click()

  const editor = appPage.locator('.automation-editor')
  await editor.getByPlaceholder('Datadog alert watcher').fill('CI babysitter')
  await editor.getByPlaceholder(/github.pull_request/).fill('github.workflow_run')
  await editor.getByPlaceholder(/"branch": "main"/).fill('{"conclusion": "failure"}')
  await editor.getByPlaceholder('Agent runs (10)').fill('3')
  await editor.getByRole('button', { name: 'Create workflow' }).click()

  const created = await lastBackendCall(appPage, 'workflow.create')
  const input = created.request.input as {
    name: string
    script: string
    triggers: unknown[]
    budget?: { maxAgentRuns?: number }
  }
  expect(input.name).toBe('CI babysitter')
  expect(input.script).toContain('await agent(')
  expect(input.triggers).toEqual([
    { kind: 'event', pattern: { type: 'github.workflow_run', filters: { conclusion: 'failure' } } }
  ])
  expect(input.budget?.maxAgentRuns).toBe(3)

  // The new card renders from the refreshed snapshot.
  await expect(appPage.locator('.automation-card').filter({ hasText: 'CI babysitter' })).toBeVisible()
})

test('run now and stop reach the engine from the workflow card', async ({ appPage }) => {
  await appPage.getByRole('button', { name: 'Workflows' }).click()
  const card = appPage.locator('.automation-card').filter({ hasText: 'Datadog alert watcher' })

  await card.getByRole('button', { name: 'Run now' }).click()
  const ran = await lastBackendCall(appPage, 'workflow.run')
  expect(ran.request).toEqual({ type: 'workflow.run', workflowId: 'workflow-watcher-seed' })
})
