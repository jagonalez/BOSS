import { control, expect, lastBackendCall, test } from './fixtures'

async function openLabAssistant(appPage: Parameters<typeof control>[0]): Promise<void> {
  await appPage.getByRole('button', { name: 'Lab Assistant', exact: true }).click()
  await expect(appPage.getByRole('heading', { name: 'Lab Assistant', exact: true })).toBeVisible()
}

test('Lab Assistant surfaces and records a merge-order decision', async ({ appPage }) => {
  await control(appPage).then((item) => item.resetCalls())
  await openLabAssistant(appPage)
  const assistant = appPage.getByRole('region', { name: 'Lab Assistant decisions' })
  await expect(assistant).toBeVisible()
  await expect(assistant).toContainText('Which should merge first?')

  await control(appPage).then((item) => item.failNextBackendRequest('assistant.answer', 'Decision store unavailable'))
  await assistant.getByRole('button', { name: '#21 · Mobile polish' }).click()
  await expect(appPage.getByRole('alert')).toContainText('Decision store unavailable')
  await expect(assistant).toContainText('Which should merge first?')

  await assistant.getByRole('button', { name: '#22 · Eval foundation' }).click()

  expect((await lastBackendCall(appPage, 'assistant.answer')).request).toEqual({
    type: 'assistant.answer',
    questionId: 'assistant-question-order',
    answerId: 'octo/hello#22'
  })
  await expect(assistant).toContainText('Nothing needs a decision.')
})

test('Lab Assistant creates, unblocks, and assigns project tasks', async ({ appPage }) => {
  await control(appPage).then((item) => item.resetCalls())
  await openLabAssistant(appPage)
  const assistant = appPage.getByRole('region', { name: 'Lab Assistant tasks' })
  await assistant.getByRole('textbox', { name: 'New Lab Assistant task' }).fill('Monitor test failures')
  await assistant.getByRole('combobox', { name: 'Task project' }).selectOption({ label: 'project' })
  await assistant.getByRole('combobox', { name: 'Task dependency' }).selectOption({ label: 'After Plan task workflow' })
  await assistant.getByRole('button', { name: 'Add task' }).click()

  expect((await lastBackendCall(appPage, 'assistant.task.create')).request).toEqual({
    type: 'assistant.task.create',
    input: {
      title: 'Monitor test failures',
      projectPath: '/tmp/boss-e2e/project',
      dependsOn: ['assistant-task-plan']
    }
  })
  const created = assistant.locator('article.lab-task').filter({
    has: appPage.getByText('Monitor test failures', { exact: true })
  })
  await expect(created).toContainText('blocked')

  const prerequisite = assistant.locator('article.lab-task').filter({
    has: appPage.getByText('Plan task workflow', { exact: true })
  })
  await prerequisite
    .getByRole('button', { name: 'Complete task: Plan task workflow', exact: true })
    .click()
  await expect(created).toContainText('ready')
  await created.getByRole('combobox', { name: 'Assign Monitor test failures' }).selectOption({ label: 'Source thread' })

  expect((await lastBackendCall(appPage, 'assistant.task.assign')).request).toEqual({
    type: 'assistant.task.assign',
    taskId: 'assistant-task-3',
    threadId: 'thread-source'
  })
  await expect(created).toContainText('running')
})

test('Lab Assistant shows the failed CI evidence routed to an owning agent', async ({ appPage }) => {
  await openLabAssistant(appPage)
  const assistant = appPage.getByRole('region', { name: 'Lab Assistant CI monitoring' })
  const incident = assistant.locator('article.lab-ci-incident').filter({
    has: appPage.getByText('CI', { exact: true })
  })

  await expect(incident).toContainText('failing')
  await expect(incident).toContainText('PR #22')
  await expect(incident).toContainText('run #19, attempt 2')
  await expect(incident).toContainText('2 consecutive failures')
  await expect(incident).toContainText('Electron end-to-end · Run npm run test:e2e')
  await expect(incident).toContainText('Source thread')
  await expect(incident.getByRole('button', { name: 'Open CI run 19' })).toBeVisible()
})
