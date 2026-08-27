import { backendCalls, expect, lastBackendCall, test } from './fixtures'

test('agent-created artifacts have a durable inbox, rich detail, and source-thread provenance', async ({ appPage }) => {
  await appPage.getByRole('button', { name: 'Reports' }).click()

  await expect(appPage.locator('.reports-page')).toBeVisible()
  await expect(appPage.getByRole('heading', { name: 'Reports' })).toBeVisible()

  const inbox = appPage.getByRole('region', { name: 'Report inbox' })
  await expect(inbox.getByRole('button', { name: /Launch readiness brief/ })).toContainText('Claude-created artifact')
  await expect(inbox.getByRole('button', { name: /Codex changelog/ })).toContainText('Codex added report history')

  const detail = appPage.getByRole('article', { name: 'Report detail' })
  await expect(detail.getByRole('heading', { name: 'Launch readiness brief' })).toBeVisible()
  await expect(detail).toContainText('Ship behind a feature flag.')
  await expect(detail.getByRole('table')).toContainText('Guided rollout')
  await expect(detail).toContainText('claude')

  const read = await lastBackendCall(appPage, 'report.read')
  expect(read.request).toEqual({ type: 'report.read', reportId: 'report-agent-seed' })

  await detail.getByRole('button', { name: 'Source thread' }).click()
  await expect(appPage.locator('.workspace-shell')).toBeVisible()
  await expect(appPage.locator('.reports-page')).not.toBeVisible()
  await expect.poll(async () => (await backendCalls(appPage, 'thread.messages'))
    .some((call) => call.request.threadId === 'thread-report-source')).toBe(true)
})

test('an automation run keeps its source thread without creating a report shortcut', async ({ appPage }) => {
  await appPage.getByRole('button', { name: 'Automations' }).click()
  const card = appPage.locator('.automation-card').filter({ hasText: 'Review incoming PRs' })
  await expect(card.getByRole('button', { name: 'Report' })).toHaveCount(0)
  await card.getByRole('button', { name: 'Thread' }).click()

  await expect(appPage.locator('.workspace-shell')).toBeVisible()
  await expect.poll(async () => (await backendCalls(appPage, 'thread.messages'))
    .some((call) => call.request.threadId === 'thread-report-source')).toBe(true)
})

test('clicking the already selected report keeps its loaded detail visible', async ({ appPage }) => {
  await appPage.getByRole('button', { name: 'Reports' }).click()

  const inbox = appPage.getByRole('region', { name: 'Report inbox' })
  const report = inbox.getByRole('button', { name: /Launch readiness brief/ })
  const detail = appPage.getByRole('article', { name: 'Report detail' })

  await expect(detail).toContainText('Ship behind a feature flag.')
  await report.click()

  await expect(detail).toContainText('Ship behind a feature flag.')
  await expect(detail).not.toContainText('Loading report')
})

test('a report can be deleted without deleting its source thread', async ({ appPage }) => {
  await appPage.getByRole('button', { name: 'Reports' }).click()

  const inbox = appPage.getByRole('region', { name: 'Report inbox' })
  const detail = appPage.getByRole('article', { name: 'Report detail' })
  await expect(detail.getByRole('heading', { name: 'Launch readiness brief' })).toBeVisible()

  await detail.getByRole('button', { name: 'Delete' }).click()
  const confirm = appPage.locator('.modal').filter({ hasText: 'Delete report?' })
  await expect(confirm.getByRole('heading', { name: 'Delete report?' })).toBeVisible()
  await confirm.getByRole('button', { name: 'Delete', exact: true }).click()

  const deleted = await lastBackendCall(appPage, 'report.delete')
  expect(deleted.request).toEqual({ type: 'report.delete', reportId: 'report-agent-seed' })
  await expect(inbox.getByRole('button', { name: /Launch readiness brief/ })).toHaveCount(0)
  await expect(detail.getByRole('heading', { name: 'Codex changelog' })).toBeVisible()

  await detail.getByRole('button', { name: 'Source thread' }).click()
  await expect.poll(async () => (await backendCalls(appPage, 'thread.messages'))
    .some((call) => call.request.threadId === 'thread-report-source')).toBe(true)
})
