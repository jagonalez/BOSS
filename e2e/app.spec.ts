import { backendCalls, control, expect, lastBackendCall, test } from './fixtures'

async function openSettings(page: Parameters<typeof control>[0]): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.locator('.settings-page-title strong')).toHaveText('Settings')
}

async function configureClaudeDefaults(page: Parameters<typeof control>[0]): Promise<void> {
  await openSettings(page)
  await page.getByRole('button', { name: 'Agent defaults' }).click()
  await page.locator('.settings-backend').filter({ hasText: 'Claude Code' }).click()
  await page.getByRole('button', { name: 'Models & connections' }).click()

  const row = page.locator('.settings-connection-row').filter({ hasText: 'Claude Code' })
  await row.locator('.settings-model-picker-trigger').click()
  await row.getByRole('button', { name: /Claude Opus 5/ }).click()

  const permission = row.locator('label').filter({ hasText: 'Permissions' }).getByRole('combobox')
  await permission.selectOption('auto')
  await expect(page.getByRole('heading', { name: /Start every Claude Code thread/ })).toBeVisible()
  await page.getByRole('button', { name: 'Use auto by default' }).click()
  await row.locator('label').filter({ hasText: 'Thinking' }).getByRole('combobox').selectOption('high')
}

test('boots the real Electron renderer without covering it with a modal', async ({ appPage, electronApp }) => {
  await expect(appPage.getByRole('heading', { name: 'Here’s what’s happening.' })).toBeVisible()
  await expect(appPage.locator('.settings-page')).toHaveCount(0)
  await expect(appPage.locator('.modal-backdrop')).toHaveCount(0)
  expect(await electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    return { count: BrowserWindow.getAllWindows().length, visible: window?.isVisible() }
  })).toEqual({ count: 1, visible: false })
})

test('persists backend, model, permission, and thinking defaults through the UI', async ({ appPage }) => {
  await configureClaudeDefaults(appPage)

  await expect.poll(async () => (await control(appPage)).defaults()).toMatchObject({
    claude: { providerID: 'anthropic', modelID: 'claude-opus-5', mode: 'auto', variant: 'high' }
  })
  const call = await lastBackendCall(appPage, 'backend.defaults.set')
  expect(call.request.defaults).toMatchObject({
    claude: { providerID: 'anthropic', modelID: 'claude-opus-5', mode: 'auto', variant: 'high' }
  })

  await appPage.getByRole('button', { name: 'Done' }).click()
  await expect(appPage.locator('.settings-page')).toHaveCount(0)
  await appPage.reload()
  await openSettings(appPage)
  const row = appPage.locator('.settings-connection-row').filter({ hasText: 'Claude Code' })
  await expect(row.locator('.settings-model-picker-trigger')).toContainText('Claude Opus 5')
  await expect(row.locator('label').filter({ hasText: 'Permissions' }).getByRole('combobox')).toHaveValue('auto')
  await expect(row.locator('label').filter({ hasText: 'Thinking' }).getByRole('combobox')).toHaveValue('high')
})

test('quick-create uses the configured backend and exposes its defaults on the new thread', async ({ appPage }) => {
  await configureClaudeDefaults(appPage)
  await appPage.getByRole('button', { name: 'Done' }).click()
  await control(appPage).then((item) => item.resetCalls())

  await appPage.getByRole('tab', { name: /Chats/ }).click()
  await appPage.getByRole('button', { name: 'New chat' }).click()
  const created = await lastBackendCall(appPage, 'thread.create')
  expect(created.request).toMatchObject({ backendId: 'claude', scope: 'global' })

  await expect(appPage.getByRole('tab', { name: /^New claude thread/ })).toBeVisible()
  await expect(appPage.locator('.model-picker-btn').filter({ hasText: 'Claude Opus 5' })).toBeVisible()
  await expect(appPage.locator('.model-picker-btn').filter({ hasText: 'Auto' })).toBeVisible()
  await expect(appPage.locator('.model-picker-btn').filter({ hasText: 'high' })).toBeVisible()
})

test('delegation sends the chosen backend, worktree placement, and target defaults', async ({ appPage }) => {
  await configureClaudeDefaults(appPage)
  await appPage.getByRole('button', { name: 'Done' }).click()
  await control(appPage).then((item) => item.resetCalls())

  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click({ button: 'right' })
  await appPage.getByRole('button', { name: 'Delegate…' }).click()
  await expect(appPage.getByRole('heading', { name: /Delegate from “Source thread”/ })).toBeVisible()
  await appPage.locator('.delegate-backends button').filter({ hasText: 'Claude' }).click()
  await appPage.getByLabel('New Git worktree').check()
  await appPage.getByPlaceholder('What should the worker accomplish?').fill('Audit the E2E workflow and report gaps.')
  await appPage.getByRole('button', { name: 'Start delegate' }).click()

  const delegated = await lastBackendCall(appPage, 'thread.delegate')
  expect(delegated.request).toMatchObject({
    threadId: 'thread-source',
    backendId: 'claude',
    instruction: 'Audit the E2E workflow and report gaps.',
    placement: 'new-worktree',
    options: {
      model: { providerID: 'anthropic', modelID: 'claude-opus-5', variant: 'high' },
      mode: 'auto'
    }
  })
  await expect(appPage.locator('.delegate-modal')).toHaveCount(0)
})

test('ask mode surfaces permission requests and replies from the card', async ({ appPage }) => {
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  await control(appPage).then((item) => item.resetCalls())
  await control(appPage).then((item) => item.emit({
    type: 'permission.asked',
    properties: {
      id: 'permission-e2e',
      sessionID: 'thread-source',
      permission: 'shell',
      patterns: ['npm test'],
      metadata: { command: 'npm test' }
    }
  }))

  await expect(appPage.locator('.perm-card')).toContainText('npm test')
  await appPage.locator('.perm-card').getByRole('button', { name: /Allow once/i }).click()
  expect((await lastBackendCall(appPage, 'thread.permission')).request).toMatchObject({
    threadId: 'thread-source', permissionId: 'permission-e2e', response: 'once'
  })
  await expect(appPage.locator('.perm-card')).toHaveCount(0)
})

test('auto mode answers permission requests without leaving a blocking panel', async ({ appPage }) => {
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  await appPage.locator('.model-picker-btn').filter({ hasText: 'Ask' }).click()
  await appPage.locator('.model-row').filter({ hasText: /^Auto/ }).click()
  await appPage.getByRole('button', { name: 'Enable Auto' }).click()
  await control(appPage).then((item) => item.resetCalls())

  await control(appPage).then((item) => item.emit({
    type: 'permission.asked',
    properties: { id: 'permission-auto', sessionID: 'thread-source', permission: 'shell' }
  }))
  await expect.poll(async () => (await backendCalls(appPage, 'thread.permission')).length).toBe(1)
  expect((await lastBackendCall(appPage, 'thread.permission')).request).toMatchObject({
    threadId: 'thread-source', permissionId: 'permission-auto', response: 'once'
  })
  await expect(appPage.locator('.perm-card')).toHaveCount(0)
  await expect(appPage.locator('.modal-backdrop')).toHaveCount(0)
})
