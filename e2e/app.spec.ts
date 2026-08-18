import { backendCalls, control, expect, lastBackendCall, test } from './fixtures'
import type { BossApi } from '../src/shared/api'

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

test('a deleted checkout returns a review snapshot without rejecting the IPC handler', async ({ appPage }) => {
  const checkout = '/tmp/boss-e2e/deleted-worktree'
  const snapshot = await appPage.evaluate(
    (path) => (window as unknown as { boss: BossApi }).boss.reviewSnapshot(path),
    checkout
  )
  expect(snapshot).toMatchObject({ repositoryRoot: checkout, branch: '', localComments: [] })
  expect(snapshot.syncError).toMatch(/git rev-parse/i)
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

test('keeps local thread auto-naming opt-in through settings', async ({ appPage }) => {
  await openSettings(appPage)
  await appPage.getByRole('button', { name: 'Agent defaults' }).click()
  const autoName = appPage.getByRole('checkbox', { name: 'Auto-name threads' })
  await expect(autoName).not.toBeChecked()
  await autoName.check()
  expect((await lastBackendCall(appPage, 'thread.title.settings.set')).request).toEqual({
    type: 'thread.title.settings.set',
    autoNameFromFirstPrompt: true
  })

  await appPage.getByRole('button', { name: 'Done' }).click()
  await appPage.reload()
  await openSettings(appPage)
  await appPage.getByRole('button', { name: 'Agent defaults' }).click()
  await expect(appPage.getByRole('checkbox', { name: 'Auto-name threads' })).toBeChecked()
})

test('a backend server can be restarted from settings', async ({ appPage }) => {
  // A server reads its credentials once, at startup. Signing in to another
  // account leaves it using the account that signed out, and this is the way
  // out of that without quitting BOSS.
  await openSettings(appPage)
  await appPage.getByRole('button', { name: 'Models & connections' }).click()
  const row = appPage.locator('.settings-connection-row').filter({ hasText: 'Codex' })

  await row.getByRole('button', { name: 'Restart server' }).click()

  expect((await lastBackendCall(appPage, 'backend.restart')).request).toMatchObject({ backendId: 'codex' })
  await expect(row.getByRole('button', { name: 'Restarted' })).toBeVisible()
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

test('a thread an agent spawned shows the model it runs on, not the app default', async ({ appPage }) => {
  // The composer reported the app's model for a thread the renderer never
  // created, because only main knew what that thread had resolved. It also sent
  // that wrong model with the next message, so the display and the thread's
  // real model disagreed.
  await configureClaudeDefaults(appPage)
  await appPage.getByRole('button', { name: 'Done' }).click()

  const spawned = await control(appPage).then((item) => item.spawnThread('claude', 'Agent spawned thread'))
  expect(spawned).toMatchObject({ model: { id: 'claude-opus-5', provider: 'anthropic' } })

  await appPage.locator('.session-row').filter({ hasText: 'Agent spawned thread' }).click()
  await expect(appPage.locator('.model-picker-btn').filter({ hasText: 'Claude Opus 5' })).toBeVisible()
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

test('a second message sent before the first is acknowledged is queued, not lost', async ({ appPage }) => {
  // The renderer decided between sending and queueing from its own copy of the
  // busy state. Two quick sends both read "idle", both started a run, and the
  // next transcript reload replaced one message with the other. Main refuses
  // the second run now, and the renderer queues what it refuses.
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  const composer = appPage.getByPlaceholder(/^Ask /)
  await composer.fill('First message.')
  await composer.press('Enter')
  await composer.fill('Second message, sent immediately.')
  await composer.press('Enter')

  // Scoped: this thread is seeded with a queued follow-up of its own.
  await expect(
    appPage.locator('.followup-text').filter({ hasText: 'Second message, sent immediately.' })
  ).toHaveCount(1)
  // Both were attempted; only the first became a run.
  expect(await backendCalls(appPage, 'thread.send')).toHaveLength(2)
  expect((await lastBackendCall(appPage, 'thread.followups.add')).request).toMatchObject({
    threadId: 'thread-source', text: 'Second message, sent immediately.'
  })
})

test('an opencode Stop & redirect does not report the stop as a failure', async ({ appPage }) => {
  // Opencode answers the abort BOSS sends with MessageAbortedError. The
  // redirect works, so showing that to the user names a failure that did not
  // happen.
  await appPage.locator('.session-row').filter({ hasText: 'OpenCode stop thread' }).click()
  await control(appPage).then((item) => item.emit({
    type: 'session.status',
    properties: { sessionID: 'thread-opencode-stop', status: { type: 'busy' } }
  }))
  await expect(appPage.locator('.followup-text')).toHaveText('Redirect this opencode run instead.')

  await appPage.getByRole('button', { name: 'Stop & redirect' }).click()
  expect((await lastBackendCall(appPage, 'thread.followups.steer')).request).toMatchObject({
    threadId: 'thread-opencode-stop', followUpId: 'followup-source'
  })

  // What opencode answers the abort with. The user asked for this, so it must
  // not reach them as a failure.
  await control(appPage).then((item) => item.emit({
    type: 'session.error',
    properties: {
      sessionID: 'thread-opencode-stop',
      error: { name: 'MessageAbortedError', message: 'Aborted' }
    }
  }))

  await expect(appPage.locator('.followup-item')).toHaveCount(0)
  await expect(appPage.locator('.chat-error')).toHaveCount(0)
})

test('a real opencode failure still reaches the user after a stop', async ({ appPage }) => {
  // The counterpart to swallowing the abort: only the stop is hidden, so a
  // fault the thread genuinely hit is still shown.
  await appPage.locator('.session-row').filter({ hasText: 'OpenCode stop thread' }).click()
  await control(appPage).then((item) => item.emit({
    type: 'session.status',
    properties: { sessionID: 'thread-opencode-stop', status: { type: 'busy' } }
  }))
  await expect(appPage.locator('.followup-text')).toHaveText('Redirect this opencode run instead.')
  await appPage.getByRole('button', { name: 'Stop & redirect' }).click()

  await control(appPage).then((item) => item.emit({
    type: 'session.error',
    properties: { sessionID: 'thread-opencode-stop', error: { name: 'Error', message: 'Connection refused' } }
  }))

  await expect(appPage.locator('.chat-error')).toContainText('Connection refused')
})

test('Claude Stop & redirect accepts the queued instruction without showing a failure', async ({ appPage }) => {
  await appPage.locator('.session-row').filter({ hasText: 'Claude stop thread' }).click()
  await control(appPage).then((item) => item.emit({
    type: 'session.status',
    properties: { sessionID: 'thread-claude', status: { type: 'busy' } }
  }))
  await expect(appPage.locator('.followup-text')).toHaveText('Continue with the corrected instruction.')
  await control(appPage).then((item) => item.resetCalls())

  await appPage.getByRole('button', { name: 'Stop & redirect' }).click()

  expect((await lastBackendCall(appPage, 'thread.followups.steer')).request).toMatchObject({
    threadId: 'thread-claude', followUpId: 'followup-claude'
  })
  await expect(appPage.locator('.followup-item')).toHaveCount(0)
  await expect(appPage.locator('.chat-error')).toHaveCount(0)
})
