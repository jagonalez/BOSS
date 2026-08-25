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

test('an automation run opens its saved report without losing the source thread', async ({ appPage }) => {
  await appPage.getByRole('button', { name: 'Automations' }).click()
  const card = appPage.locator('.automation-card').filter({ hasText: 'Review incoming PRs' })
  await card.getByRole('button', { name: 'Report' }).click()

  await expect(appPage.locator('.reports-page')).toBeVisible()
  await expect(appPage.getByRole('article', { name: 'Report detail' })).toContainText('Codex changelog')
})
