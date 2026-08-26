import { backendCalls, expect, lastBackendCall, test } from './fixtures'

test('an agent-authored workflow is reviewed and approved from the workflows page', async ({ appPage }) => {
  await appPage.getByRole('button', { name: 'Workflows' }).click()

  await expect(appPage.locator('.workflows-page')).toBeVisible()
  // Level 1 disambiguates the page title from the list section's h2.
  await expect(appPage.getByRole('heading', { name: 'Workflows', level: 1 })).toBeVisible()

  // The seeded agent-authored workflow is disabled and flagged; because a
  // signature is being requested, its script is open for review by default.
  const card = appPage.locator('.automation-card').filter({ hasText: 'Datadog alert watcher' })
  await expect(card).toContainText('Awaiting approval')
  await expect(card).toContainText('Agent-authored')
  await expect(card.locator('.workflow-script-view')).toContainText("judge('monitor flapped'")

  // Its latest run is parked on an ask(): the question is answerable in place.
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

  // Approving is enabling: the signature moment.
  await card.getByRole('button', { name: 'Approve & enable' }).click()
  const enabled = await lastBackendCall(appPage, 'workflow.update')
  expect(enabled.request).toEqual({ type: 'workflow.update', workflowId: 'workflow-watcher-seed', patch: { enabled: true } })
})

test('the approval mode is a trust dial like permission modes', async ({ appPage }) => {
  await appPage.getByRole('button', { name: 'Workflows' }).click()
  const select = appPage.getByRole('combobox', { name: 'Workflow approval mode' })
  await expect(select).toHaveValue('ask')
  await select.selectOption('auto')
  const set = await lastBackendCall(appPage, 'workflow.approval.set')
  expect(set.request).toEqual({ type: 'workflow.approval.set', mode: 'auto' })
  await expect(select).toHaveValue('auto')
})

test('new workflows are described to an agent, never written in a form', async ({ appPage }) => {
  await appPage.getByRole('button', { name: 'Workflows' }).click()
  await appPage.getByRole('button', { name: 'New workflow' }).click()

  // There is no script editor: the composer is a request, handed to a seeded
  // agent conversation that authors and tests the workflow with the
  // boss_workflow_* tools.
  await expect(appPage.locator('.workflows-page textarea.workflow-script')).toHaveCount(0)
  await appPage
    .getByRole('textbox', { name: 'Workflow request' })
    .fill('Watch CI on main and escalate failures to a stronger agent.')
  await appPage.getByRole('button', { name: 'Hand to an agent' }).click()

  const created = await lastBackendCall(appPage, 'thread.create')
  expect(created.request).toMatchObject({ type: 'thread.create', title: 'New workflow' })
  await expect
    .poll(async () =>
      // An idle thread gets a direct thread.send; a busy one gets a queued
      // follow-up. The seeded prompt is valid arriving either way.
      (await backendCalls(appPage)).some((call) => {
        if (call.request.type !== 'thread.send' && call.request.type !== 'thread.followups.add') return false
        const text = JSON.stringify(call.request)
        return text.includes('[Workflow authoring request]') && text.includes('Watch CI on main')
      })
    )
    .toBe(true)
  // The page handed off to the conversation.
  await expect(appPage.locator('.workspace-shell')).toBeVisible()
})

test('refining goes through an agent conversation seeded with the workflow id', async ({ appPage }) => {
  await appPage.getByRole('button', { name: 'Workflows' }).click()
  const card = appPage.locator('.automation-card').filter({ hasText: 'Datadog alert watcher' })
  await card.getByRole('button', { name: 'Refine with agent' }).click()

  await appPage
    .getByRole('textbox', { name: 'Workflow refinement request' })
    .fill('Batch flaky monitors into a weekly digest instead of asking me.')
  await appPage.getByRole('button', { name: 'Hand to an agent' }).click()

  const created = await lastBackendCall(appPage, 'thread.create')
  expect(created.request).toMatchObject({ type: 'thread.create', title: 'Refine workflow · Datadog alert watcher' })
  await expect
    .poll(async () =>
      // An idle thread gets a direct thread.send; a busy one gets a queued
      // follow-up. The seeded prompt is valid arriving either way.
      (await backendCalls(appPage)).some((call) => {
        if (call.request.type !== 'thread.send' && call.request.type !== 'thread.followups.add') return false
        const text = JSON.stringify(call.request)
        return text.includes('[Workflow refinement request]') && text.includes('workflow-watcher-seed')
      })
    )
    .toBe(true)
})

test('run now reaches the engine from the workflow card', async ({ appPage }) => {
  await appPage.getByRole('button', { name: 'Workflows' }).click()
  const card = appPage.locator('.automation-card').filter({ hasText: 'Datadog alert watcher' })
  await card.getByRole('button', { name: 'Run now' }).click()
  const ran = await lastBackendCall(appPage, 'workflow.run')
  expect(ran.request).toEqual({ type: 'workflow.run', workflowId: 'workflow-watcher-seed' })
})
