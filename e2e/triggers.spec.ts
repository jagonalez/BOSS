import { control, expect, lastBackendCall, test } from './fixtures'

type Page = Parameters<typeof control>[0]

async function openSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.locator('.settings-page-title strong')).toHaveText('Settings')
}

async function openAutomations(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Automations' }).click()
  await expect(page.locator('.automations-page')).toBeVisible()
}

test('a GitHub webhook automation is created with its event config and shows a copyable hook URL', async ({ appPage }) => {
  await control(appPage).then((item) => item.resetCalls())
  await openAutomations(appPage)
  await appPage.getByRole('button', { name: 'New automation' }).click()

  await appPage.getByPlaceholder('Morning changelog report').fill('Triage hooks')
  await appPage.getByPlaceholder('What should the agent do on every run?').fill('Summarize {{event}} on {{branch}}.')
  await appPage.getByLabel('Trigger').selectOption({ label: 'GitHub webhook' })
  await appPage.getByRole('checkbox', { name: 'Push' }).uncheck()
  await appPage.getByRole('checkbox', { name: 'Pull request opened' }).check()
  await appPage.getByLabel('Branch filter').fill('main')
  await expect(appPage.getByRole('checkbox', { name: 'Save the final response to Reports' })).toHaveCount(0)

  await appPage.getByRole('button', { name: 'Create automation' }).click()

  const created = await lastBackendCall(appPage, 'automation.create')
  expect(created.request).toMatchObject({
    type: 'automation.create',
    input: {
      name: 'Triage hooks',
      schedule: { kind: 'manual' },
      webhook: { events: ['pull_request'], branch: 'main' }
    }
  })
  expect(created.request.input).not.toHaveProperty('saveReport')

  // The editor stays open so the freshly generated URL can be copied into GitHub.
  const urlPanel = appPage.locator('[aria-label="Webhook URL"]')
  await expect(urlPanel).toContainText('http://127.0.0.1:4528/hooks/')
  await urlPanel.getByRole('button', { name: 'Copy' }).click()
})

test('webhook automations carry their trigger and last delivery on the card', async ({ appPage }) => {
  await openAutomations(appPage)
  const card = appPage.locator('.automation-card').filter({ hasText: 'Review incoming PRs' })
  await expect(card).toContainText('GitHub webhook · Pull request opened → main')
  await expect(card).toContainText('pull_request · #14 · opened · octo/hello')
  await expect(card.getByRole('button', { name: 'Copy URL' })).toBeVisible()
})

test('Telegram messaging is wired through settings and off until fully configured', async ({ appPage }) => {
  await openSettings(appPage)
  await appPage.getByRole('button', { name: 'Telegram', exact: true }).click()

  const section = appPage.getByRole('region', { name: 'Telegram messaging' })
  await expect(section.getByText('Off', { exact: true })).toBeVisible()

  // Enabling before configuring is refused locally, without a round trip.
  await section.getByRole('button', { name: 'Enable' }).click()
  await expect(section.getByText('Add your bot token from @BotFather before enabling.')).toBeVisible()

  const tokenRow = section.locator('.ui-settings-row').filter({ hasText: 'Bot token' })
  await tokenRow.getByLabel('Telegram bot token').fill('123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
  await tokenRow.getByRole('button', { name: 'Save' }).click()
  const saved = await lastBackendCall(appPage, 'telegram.set')
  expect(saved.request).toMatchObject({
    type: 'telegram.set',
    patch: { token: '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }
  })
  await expect(tokenRow.getByText('Token saved')).toBeVisible()

  // With a token but no target thread, enabling is refused once more.
  await section.getByRole('button', { name: 'Enable' }).click()
  await expect(section.getByText('Choose which thread messages are delivered to before enabling.')).toBeVisible()

  await section.getByLabel('Telegram delivery thread').selectOption({ label: 'Source thread' })
  const targeted = await lastBackendCall(appPage, 'telegram.set')
  expect(targeted.request).toMatchObject({ type: 'telegram.set', patch: { threadId: 'thread-source' } })

  await section.getByRole('button', { name: 'Enable' }).click()
  const enabledCall = await lastBackendCall(appPage, 'telegram.set')
  expect(enabledCall.request).toMatchObject({ type: 'telegram.set', patch: { enabled: true } })
  await expect(section.getByText('Running', { exact: true })).toBeVisible()
})
