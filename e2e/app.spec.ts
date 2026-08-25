import assert from 'node:assert/strict'
import { backendCalls, control, expect, gitCalls, lastBackendCall, test } from './fixtures'
import type { BossApi } from '../src/shared/api'

async function openSettings(page: Parameters<typeof control>[0]): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.locator('.settings-page-title strong')).toHaveText('Settings')
}

async function chooseWorkspaceLayout(
  page: Parameters<typeof control>[0],
  label: 'Single-thread' | 'Multi-thread'
): Promise<void> {
  await openSettings(page)
  await page.getByRole('button', { name: 'Appearance', exact: true }).click()
  await page.getByRole('radio', { name: new RegExp(`^${label}`) }).click()
  await page.getByRole('button', { name: 'Done' }).click()
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

test('switching workspace layouts restores the views previously shown in each mode', async ({ appPage }) => {
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  await appPage.locator('.session-row').filter({ hasText: 'Duplicate transcript' }).click()

  const projectViews = appPage.getByRole('tablist', { name: 'Project views' })
  const visibleCanvas = appPage.locator('.workspace-canvas:not([hidden])')
  await expect(projectViews.locator('.workspace-view-tab')).toHaveCount(1)
  await expect(visibleCanvas.locator('.workspace-tab').filter({ hasText: 'Source thread' })).toHaveCount(1)
  await expect(visibleCanvas.locator('.workspace-tab').filter({ hasText: 'Duplicate transcript' })).toHaveCount(1)

  await chooseWorkspaceLayout(appPage, 'Single-thread')
  await expect(projectViews).toBeHidden()
  const firstSingleViewIds = await appPage.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('boss.workspace.single') ?? '{"views":[]}') as { views: Array<{ id: string }> }
    return saved.views.map((view) => view.id)
  })
  expect(firstSingleViewIds).toHaveLength(2)

  await chooseWorkspaceLayout(appPage, 'Multi-thread')
  await expect(projectViews).toBeVisible()
  await expect(projectViews.locator('.workspace-view-tab')).toHaveCount(1)
  await expect(visibleCanvas.locator('.workspace-tab').filter({ hasText: 'Source thread' })).toHaveCount(1)
  await expect(visibleCanvas.locator('.workspace-tab').filter({ hasText: 'Duplicate transcript' })).toHaveCount(1)

  await chooseWorkspaceLayout(appPage, 'Single-thread')
  const restoredSingleViewIds = await appPage.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('boss.workspace.single') ?? '{"views":[]}') as { views: Array<{ id: string }> }
    return saved.views.map((view) => view.id)
  })
  expect(restoredSingleViewIds).toEqual(firstSingleViewIds)

  await chooseWorkspaceLayout(appPage, 'Multi-thread')
  await expect(projectViews.locator('.workspace-view-tab')).toHaveCount(1)
})

test('keeps a theme family while light, dark, and system appearance change', async ({ appPage }) => {
  await appPage.emulateMedia({ colorScheme: 'dark' })
  await openSettings(appPage)
  await appPage.getByRole('button', { name: 'Appearance' }).click()

  const familyChoices = appPage.getByRole('radiogroup', { name: 'Theme family' })
  await expect(familyChoices.getByRole('radio')).toHaveCount(10)
  for (const name of ['Gruvbox', 'Everforest', 'Kanagawa', 'Ayu']) {
    await expect(familyChoices.getByRole('radio', { name: new RegExp(`^${name}`) })).toBeVisible()
  }

  const family = appPage.getByRole('radio', { name: /^Catppuccin/ })
  await family.click()
  await appPage.getByRole('radio', { name: /^Light/ }).click()
  await expect(appPage.locator('html')).toHaveAttribute('data-theme-family', 'catppuccin')
  await expect(appPage.locator('html')).toHaveAttribute('data-theme-appearance', 'light')
  await expect(appPage.locator('html')).toHaveAttribute('data-theme', 'catppuccin-latte')

  await appPage.getByRole('radio', { name: /^Dark/ }).click()
  await expect(appPage.locator('html')).toHaveAttribute('data-theme', 'catppuccin-mocha')

  await appPage.getByRole('radio', { name: /^System/ }).click()
  await expect(appPage.locator('html')).toHaveAttribute('data-theme-appearance', 'system')
  await expect(appPage.locator('html')).toHaveAttribute('data-theme', 'catppuccin-mocha')
  await expect(appPage.getByText('Following system · currently dark')).toBeVisible()

  await appPage.emulateMedia({ colorScheme: 'light' })
  await expect(appPage.locator('html')).toHaveAttribute('data-theme', 'catppuccin-latte')
  await expect(appPage.getByText('Following system · currently light')).toBeVisible()
  expect(await appPage.evaluate(() => ({
    family: localStorage.getItem('boss.themeFamily'),
    appearance: localStorage.getItem('boss.themeAppearance')
  }))).toEqual({ family: 'catppuccin', appearance: 'system' })

  await appPage.getByRole('button', { name: 'Done' }).click()
  await appPage.reload()
  await expect(appPage.locator('html')).toHaveAttribute('data-theme-family', 'catppuccin')
  await expect(appPage.locator('html')).toHaveAttribute('data-theme-appearance', 'system')
  await expect(appPage.locator('html')).toHaveAttribute('data-theme', 'catppuccin-latte')
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

test('Ctrl+F searches the active thread and moves between its matches', async ({ appPage }) => {
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  await expect(appPage.getByText('Search marker: first result.')).toBeVisible()

  await appPage.keyboard.press('Control+f')
  const search = appPage.getByRole('search', { name: 'Search this thread' })
  await expect(search).toBeVisible()
  const input = search.getByRole('searchbox', { name: 'Find in thread' })
  await expect(input).toBeFocused()
  await input.fill('search marker')

  await expect(search).toContainText('1 of 2')
  await expect(appPage.locator('.msg.thread-search-current')).toContainText('first result')
  await appPage.keyboard.press('Enter')
  await expect(search).toContainText('2 of 2')
  await expect(appPage.locator('.msg.thread-search-current')).toContainText('second result')
  await appPage.keyboard.press('Shift+Enter')
  await expect(search).toContainText('1 of 2')

  await appPage.keyboard.press('Escape')
  await expect(search).toHaveCount(0)
})

test('a long virtual transcript keeps its exact reading position and searches unmounted history', async ({ appPage }) => {
  const fixture = await control(appPage)
  await fixture.installLongThread(320)
  await appPage.locator('.session-row').filter({ hasText: 'Long performance thread' }).click()
  await expect(appPage.getByText('Long transcript response 319.')).toBeVisible()

  // The data model contains 640 messages, but only the viewport-sized slice is
  // allowed into the expensive Markdown/step-card DOM.
  await expect.poll(() => appPage.locator('.messages .msg').count()).toBeLessThan(50)
  const scroller = appPage.locator('.messages:visible')
  await scroller.evaluate((element) => {
    element.scrollTop = Math.round((element.scrollHeight - element.clientHeight) * 0.46)
    element.dispatchEvent(new Event('scroll'))
  })

  const readingAnchor = async (): Promise<{ key: string; offset: number } | null> => scroller.evaluate((element) => {
    const viewport = element.getBoundingClientRect()
    const turns = Array.from(element.querySelectorAll<HTMLElement>('.transcript-virtual-turn'))
      .map((turn) => ({ turn, rect: turn.getBoundingClientRect() }))
      .filter(({ rect }) => rect.bottom > viewport.top)
      .sort((left, right) => left.rect.top - right.rect.top)
    const first = turns[0]
    if (!first) return null
    return {
      key: first.turn.querySelector<HTMLElement>('[data-turn-key]')?.dataset.turnKey ?? '',
      offset: Math.round(first.rect.top - viewport.top)
    }
  })
  await expect.poll(readingAnchor).not.toBeNull()
  const before = await readingAnchor()

  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  await expect(appPage.getByText('Search marker: first result.')).toBeVisible()
  await appPage.locator('.session-row').filter({ hasText: 'Long performance thread' }).click()
  await expect.poll(readingAnchor).toEqual(before)

  await appPage.keyboard.press('Control+f')
  const search = appPage.getByRole('search', { name: 'Search this thread' })
  await search.getByRole('searchbox', { name: 'Find in thread' }).fill('deep virtual search target')
  await expect(search).toContainText('1 of 2')
  await expect(appPage.locator('.msg.thread-search-current')).toContainText('near the start')
  await appPage.keyboard.press('Enter')
  await expect(search).toContainText('2 of 2')
  await expect(appPage.locator('.msg.thread-search-current')).toContainText('near the end')
  await expect.poll(() => appPage.locator('.messages .msg').count()).toBeLessThan(50)
})

test('shows an attached image and one copy of a response echoed under two message ids', async ({ appPage }) => {
  await appPage.locator('.session-row').filter({ hasText: 'Duplicate transcript' }).click()

  await expect(appPage.getByRole('img', { name: 'duplicate-example.png' })).toBeVisible()
  await expect(appPage.getByText('Critical find. Let me inspect it.')).toHaveCount(1)
  await expect(appPage.locator('.step-card')).toHaveCount(2)
})

test('shows Lab reasoning separately from the final answer', async ({ appPage }) => {
  const sessionID = 'thread-source'
  const messageID = 'lab-reasoning-e2e'
  const created = Date.now()
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()

  await control(appPage).then((item) => item.emit({
    type: 'message.updated',
    properties: {
      info: {
        id: messageID,
        sessionID,
        role: 'assistant',
        model: { id: 'ox-alpha' },
        time: { created, completed: created + 1 }
      }
    }
  }))
  await control(appPage).then((item) => item.emit({
    type: 'message.part.updated',
    properties: {
      part: {
        id: `${messageID}-reasoning`,
        type: 'reasoning',
        sessionID,
        messageID,
        text: 'I should inspect Workspace.tsx before answering.'
      }
    }
  }))
  await control(appPage).then((item) => item.emit({
    type: 'message.part.updated',
    properties: {
      part: {
        id: `${messageID}-text`,
        type: 'text',
        sessionID,
        messageID,
        text: 'The workspace selection is now fixed.'
      }
    }
  }))

  const reply = appPage.locator(`.msg-body[data-message-id="${messageID}"]`)
  await expect(reply).toContainText('The workspace selection is now fixed.')
  await expect(reply).not.toContainText('<think>')
  await reply.locator('.thought-head').click()
  await expect(reply.locator('.thought-body')).toContainText('I should inspect Workspace.tsx before answering.')
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

test('keeps thread auto-naming opt-in through settings', async ({ appPage }) => {
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

test('auto-names with a generated title and falls back to a short local label', async ({ appPage }) => {
  await openSettings(appPage)
  await appPage.getByRole('button', { name: 'Agent defaults' }).click()
  await appPage.getByRole('checkbox', { name: 'Auto-name threads' }).check()
  await appPage.getByRole('button', { name: 'Done' }).click()

  await control(appPage).then((item) => item.spawnThread('codex', 'Untitled Codex thread'))
  await appPage.locator('.session-row').filter({ hasText: 'Untitled Codex thread' }).click()
  const composer = appPage.getByPlaceholder('Ask Codex…')
  await composer.fill('We need to fix the "automate" thread names - it is pretty bad, because they are always super long and copy the first sentence.')
  await composer.press('Enter')

  await expect(appPage.locator('.session-row').filter({ hasText: 'Improve automatic thread naming' })).toBeVisible()
  const renamed = (await control(appPage).then((item) => item.sessions()))
    .find((session) => session.id === 'thread-created-1')
  expect(renamed?.title).toBe('Improve automatic thread naming')

  await control(appPage).then((item) => item.spawnThread('claude', 'Untitled Claude thread'))
  await appPage.locator('.session-row').filter({ hasText: 'Untitled Claude thread' }).click()
  const claudeComposer = appPage.getByPlaceholder('Ask Claude…')
  await claudeComposer.fill('We need to fix the "automate" thread names - it is pretty bad, because they are always super long and copy the first sentence.')
  await claudeComposer.press('Enter')

  await expect(appPage.locator('.session-row').filter({ hasText: 'Fix "automate" thread names' })).toBeVisible()
  const fallback = (await control(appPage).then((item) => item.sessions()))
    .find((session) => session.id === 'thread-created-2')
  expect(fallback?.title).toBe('Fix "automate" thread names')
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

test('shows provider subscription windows on their own Usage page', async ({ appPage }) => {
  await openSettings(appPage)
  await expect(appPage.getByRole('button', { name: 'Refresh usage' })).toHaveCount(0)
  await appPage.getByRole('button', { name: 'Usage', exact: true }).click()
  await appPage.getByRole('button', { name: 'Refresh usage' }).click()
  expect((await lastBackendCall(appPage, 'backend.subscription-usage')).request).toEqual({ type: 'backend.subscription-usage' })
  const openCode = appPage.getByRole('region', { name: 'OpenCode Go usage' })
  await expect(openCode).toContainText('12% used · 88% left')
  await expect(openCode).toContainText('Monthly limit')
  const codex = appPage.getByRole('region', { name: 'Codex usage' })
  await expect(codex).toContainText('35% used · 65% left')
  await expect(codex).toContainText('GPT-5.3-Codex-Spark')
  const claude = appPage.getByRole('region', { name: 'Claude Code usage' })
  await expect(claude).toContainText('8% used · 92% left')
  await expect(appPage.getByText('Pi has no subscription balance of its own.')).toBeVisible()
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

test('a Claude thread can submit a message without a transport error', async ({ appPage }) => {
  const title = 'Claude SDK executable test'
  await control(appPage).then((item) => item.spawnThread('claude', title))
  await appPage.locator('.session-row').filter({ hasText: title }).click()
  await control(appPage).then((item) => item.resetCalls())

  const composer = appPage.getByPlaceholder(/^Ask /)
  await composer.fill('Verify the Claude SDK transport.')
  await composer.press('Enter')

  const call = await lastBackendCall(appPage, 'thread.send')
  expect(call.request).toMatchObject({ threadId: 'thread-created-1' })
  await expect(appPage.locator('.chat-error')).toHaveCount(0)
})

async function configureLabDefaults(page: Parameters<typeof control>[0]): Promise<void> {
  await openSettings(page)
  await page.getByRole('button', { name: 'Agent defaults' }).click()
  await page.locator('.settings-backend').filter({ hasText: 'Lab' }).click()
  await page.getByRole('button', { name: 'Models & connections' }).click()

  const row = page.locator('.settings-connection-row').filter({ hasText: 'Lab' })
  await row.locator('.settings-model-picker-trigger').click()
  await row.getByRole('button', { name: /Lab E2E/ }).click()
}

test('adds a named Lab API, key, and model from Models & connections', async ({ appPage }) => {
  await openSettings(appPage)
  const row = appPage.locator('.settings-connection-row').filter({ hasText: 'Lab' })
  const connections = row.getByRole('region', { name: 'Lab API connections' })
  await expect(connections).toBeVisible()
  await connections.getByRole('button', { name: 'Add connection' }).click()

  const editor = connections.getByRole('region', { name: 'Add Lab connection' })
  await editor.getByLabel('Lab connection name').fill('Cloud test')
  await editor.getByLabel('Lab endpoint URL').fill('https://models.example.test/v1')
  await editor.getByLabel('Lab API key').fill('test-key')
  await editor.getByLabel('Lab manual models').fill('coding-model')
  await editor.getByRole('button', { name: 'Save & test' }).click()

  const call = await lastBackendCall(appPage, 'lab.connection.save')
  expect(call.request).toEqual({
    type: 'lab.connection.save',
    connection: {
      name: 'Cloud test',
      baseUrl: 'https://models.example.test/v1',
      manualModels: ['coding-model'],
      apiKey: 'test-key'
    }
  })
  const card = connections.getByRole('article', { name: 'Cloud test Lab connection' })
  await expect(card).toContainText('Ready')
  await expect(card).toContainText('Key saved')
  await expect(card).toContainText('coding-model')

  await row.locator('.settings-model-picker-trigger').click()
  await row.getByRole('button', { name: /coding-model/ }).click()
  await expect(row.locator('.settings-model-picker-trigger')).toContainText('Cloud test')
})

test('quick-create with Lab uses the drop-in backend and its default model', async ({ appPage }) => {
  await configureLabDefaults(appPage)
  await appPage.getByRole('button', { name: 'Done' }).click()
  await control(appPage).then((item) => item.resetCalls())

  await appPage.getByRole('tab', { name: /Chats/ }).click()
  await appPage.getByRole('button', { name: 'New chat' }).click()
  const created = await lastBackendCall(appPage, 'thread.create')
  expect(created.request).toMatchObject({ backendId: 'lab', scope: 'global' })

  await expect(appPage.getByRole('tab', { name: /^New lab thread/ })).toBeVisible()
  await expect(appPage.locator('.model-picker-btn').filter({ hasText: 'Lab E2E' })).toBeVisible()
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
  const handoff = await control(appPage).then((item) => item.contextHandoff())
  const currentTask = handoff.indexOf('CURRENT TASK — AUTHORITATIVE')
  const history = handoff.indexOf('HISTORICAL TRANSCRIPT — REFERENCE ONLY')
  const staleRequest = handoff.indexOf('> Spin up a Codex thread to review this PR.')
  expect(currentTask).toBeGreaterThanOrEqual(0)
  expect(history).toBeGreaterThan(currentTask)
  expect(handoff).toContain('Delegated task: Audit the E2E workflow and report gaps.')
  expect(staleRequest).toBeGreaterThan(history)
  expect(handoff.lastIndexOf('Follow only CURRENT TASK above.')).toBeGreaterThan(staleRequest)
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

test('a running Codex thread says a permission-mode switch starts next turn', async ({ appPage }) => {
  await control(appPage).then((item) => item.spawnThread('codex', 'Codex PR worker'))
  await appPage.locator('.session-row').filter({ hasText: 'Codex PR worker' }).click()

  // Start in Auto while idle, then begin the turn that fixes its approval
  // policy. Switching to Ask during that turn must not imply that a blocked
  // git command already in flight can suddenly request approval.
  await appPage.locator('.model-picker-btn').filter({ hasText: 'Ask' }).click()
  await appPage.locator('.model-row').filter({ hasText: /^Auto/ }).click()
  await appPage.getByRole('button', { name: 'Enable Auto' }).click()
  const composer = appPage.getByPlaceholder('Ask Codex…')
  await composer.fill('Prepare and publish the pull request.')
  await composer.press('Enter')

  await appPage.locator('.model-picker-btn').filter({ hasText: 'Auto' }).click()
  await appPage.locator('.model-row').filter({ hasText: /^Ask/ }).click()
  const pending = appPage.locator('.model-picker-btn').filter({ hasText: 'Ask (next turn)' })
  await expect(pending).toBeVisible()
  await expect(pending).toHaveAttribute('title', /applies from your next message/)
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

/** Select a run of rendered text inside an assistant reply, the way a drag
 *  does, and let the popover's pointerup listener see it. Playwright has no
 *  API for a partial text selection, so the range is built in the page. */
async function selectInAssistantReply(
  page: Parameters<typeof control>[0],
  phrase: string
): Promise<void> {
  await page.evaluate((needle) => {
    const body = Array.from(document.querySelectorAll('.msg.assistant .msg-body'))
      .find((element) => element.textContent?.includes(needle))
    if (!body) throw new Error(`No assistant message containing ${needle}`)
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const index = node.textContent?.indexOf(needle) ?? -1
      if (index < 0) continue
      const range = document.createRange()
      range.setStart(node, index)
      range.setEnd(node, index + needle.length)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      return
    }
    throw new Error(`No text node containing ${needle}`)
  }, phrase)
  await page.dispatchEvent('.messages', 'pointerup')
}

test('annotating a passage quotes it back to the model with the note', async ({ appPage }) => {
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  await expect(appPage.locator('.msg.assistant')).toContainText('second result')

  await selectInAssistantReply(appPage, 'second result')
  // Dynamic virtual-row measurement may correct scrollTop after selection.
  // The toolbar belongs to the anchored words and must survive that correction
  // while those words remain in view.
  await expect(appPage.locator('.annotation-popover')).toBeVisible()
  await appPage.locator('.messages:visible').dispatchEvent('scroll')
  await expect(appPage.locator('.annotation-popover')).toBeVisible()
  await appPage.locator('.annotation-popover').getByRole('button', { name: 'Add to chat' }).click()
  await appPage.getByLabel('Annotation note').fill('Why this one?')
  await appPage.getByLabel('Annotation note').press('Enter')

  // The pill is the standing reminder that the next send carries a quote.
  await expect(appPage.locator('.annotation-pill')).toHaveCount(1)
  await expect(appPage.locator('.annotation-pill-quote')).toHaveText('second result')

  await control(appPage).then((item) => item.resetCalls())
  const composer = appPage.getByPlaceholder(/^Ask /)
  await composer.fill('Expand on that.')
  await composer.press('Enter')

  const call = await lastBackendCall(appPage, 'thread.send')
  const text = (call.request as { parts: { type: string; text?: string }[] }).parts
    .find((part) => part.type === 'text')?.text ?? ''
  expect(text).toContain('> second result')
  expect(text).toContain('Why this one?')
  expect(text).toContain('Expand on that.')
  expect(text.indexOf('> second result')).toBeLessThan(text.indexOf('Expand on that.'))

  // Cleared on send: an annotation phrases one prompt, it does not stay on the
  // thread and quote itself again on the next message.
  await expect(appPage.locator('.annotation-pill')).toHaveCount(0)
})

test('an annotation alone is a complete message', async ({ appPage }) => {
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  await expect(appPage.locator('.msg.assistant')).toContainText('second result')

  await selectInAssistantReply(appPage, 'second result')
  await appPage.locator('.annotation-popover').getByRole('button', { name: 'Add to chat' }).click()
  await appPage.getByLabel('Annotation note').fill('Say more.')
  await appPage.getByLabel('Annotation note').press('Enter')
  await expect(appPage.locator('.annotation-pill')).toHaveCount(1)

  await control(appPage).then((item) => item.resetCalls())
  // Nothing typed: the empty composer must not veto the send.
  await appPage.getByPlaceholder(/^Ask /).press('Enter')

  const call = await lastBackendCall(appPage, 'thread.send')
  const text = (call.request as { parts: { type: string; text?: string }[] }).parts
    .find((part) => part.type === 'text')?.text ?? ''
  expect(text).toContain('> second result')
  expect(text).toContain('Say more.')
})

test('a removed annotation is not carried into the next prompt', async ({ appPage }) => {
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  await expect(appPage.locator('.msg.assistant')).toContainText('second result')

  await selectInAssistantReply(appPage, 'second result')
  await appPage.locator('.annotation-popover').getByRole('button', { name: 'Add to chat' }).click()
  await appPage.getByLabel('Annotation note').fill('Never mind.')
  await appPage.getByLabel('Annotation note').press('Enter')
  await appPage.getByRole('button', { name: 'Remove annotation 1' }).click()
  await expect(appPage.locator('.annotation-pill')).toHaveCount(0)

  await control(appPage).then((item) => item.resetCalls())
  const composer = appPage.getByPlaceholder(/^Ask /)
  await composer.fill('Unrelated question.')
  await composer.press('Enter')

  const call = await lastBackendCall(appPage, 'thread.send')
  const text = (call.request as { parts: { type: string; text?: string }[] }).parts
    .find((part) => part.type === 'text')?.text ?? ''
  expect(text).toBe('Unrelated question.')
})

test('a side chat forks the thread and opens seeded with the passage', async ({ appPage }) => {
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  await expect(appPage.locator('.msg.assistant')).toContainText('second result')
  await control(appPage).then((item) => item.resetCalls())

  await selectInAssistantReply(appPage, 'second result')
  await appPage.locator('.annotation-popover').getByRole('button', { name: 'Add to side chat' }).click()

  // Forked, not freshly created: the side chat inherits the conversation the
  // passage came from, so the seed only has to point at it.
  const fork = await lastBackendCall(appPage, 'thread.fork')
  expect(fork.request).toMatchObject({ threadId: 'thread-source' })

  // Two composers now, which is the point: the side chat opens alongside its
  // parent rather than replacing it. Both live in the same group, so neither
  // the placeholder nor the focused pane tells them apart — the draft does.
  const composers = appPage.getByPlaceholder(/^Ask /)
  await expect(composers).toHaveCount(2)

  // Exactly one carries the quote and the other is empty: the seed goes to the
  // side chat without disturbing the draft in the thread it came from. Counted
  // rather than positional, since which composer renders first is a layout
  // detail this contract does not depend on.
  await expect
    .poll(async () =>
      composers.evaluateAll((nodes) => {
        const values = nodes.map((node) => (node as HTMLTextAreaElement).value)
        return {
          seeded: values.filter((value) => value.includes('> second result')).length,
          empty: values.filter((value) => value === '').length
        }
      })
    )
    .toEqual({ seeded: 1, empty: 1 })

  // The passage went to the side chat, so nothing is left pending here.
  await expect(appPage.locator('.annotation-pill')).toHaveCount(0)
})

test('a placed annotation is editable from its marker in the transcript', async ({ appPage }) => {
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  await expect(appPage.locator('.msg.assistant')).toContainText('second result')

  await selectInAssistantReply(appPage, 'second result')
  await appPage.locator('.annotation-popover').getByRole('button', { name: 'Add to chat' }).click()
  await appPage.getByLabel('Annotation note').fill('First thought.')
  await appPage.getByLabel('Annotation note').press('Enter')
  await expect(appPage.locator('.annotation-pill')).toHaveCount(1)

  // The marker is what makes a placed highlight reachable again: without it the
  // only way to revise a note is to remove the pill and re-select the words.
  const marker = appPage.locator('.annotation-marker')
  await expect(marker).toHaveCount(1)
  await expect(marker).toHaveText('1')
  await marker.click()

  // Reopens on the existing annotation rather than starting a new one, so the
  // note it already carries is there to edit.
  const note = appPage.getByLabel('Annotation note')
  await expect(note).toHaveValue('First thought.')
  await note.fill('Actually, why this one?')
  await note.press('Enter')

  // Revised in place: still one annotation, carrying the new note.
  await expect(appPage.locator('.annotation-pill')).toHaveCount(1)
  await expect(appPage.locator('.annotation-pill-note')).toHaveText('Actually, why this one?')

  await control(appPage).then((item) => item.resetCalls())
  await appPage.getByPlaceholder(/^Ask /).press('Enter')
  const call = await lastBackendCall(appPage, 'thread.send')
  const text = (call.request as { parts: { type: string; text?: string }[] }).parts
    .find((part) => part.type === 'text')?.text ?? ''
  expect(text).toContain('Actually, why this one?')
  expect(text).not.toContain('First thought.')
})

test('an annotation can be removed from its own editor', async ({ appPage }) => {
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  await expect(appPage.locator('.msg.assistant')).toContainText('second result')

  await selectInAssistantReply(appPage, 'second result')
  await appPage.locator('.annotation-popover').getByRole('button', { name: 'Add to chat' }).click()
  await appPage.getByLabel('Annotation note').press('Enter')
  await expect(appPage.locator('.annotation-pill')).toHaveCount(1)

  await appPage.locator('.annotation-marker').click()
  // Scoped to the editor: the composer pill carries a remove button too, and
  // this is asserting the transcript can undo an annotation on its own.
  await appPage.locator('.annotation-editor').getByRole('button', { name: 'Remove annotation' }).click()

  // Gone from the transcript and the composer together: the highlight, its
  // marker, and the pending quote are one thing seen from three places.
  await expect(appPage.locator('.annotation-pill')).toHaveCount(0)
  await expect(appPage.locator('.annotation-marker')).toHaveCount(0)
})

test('a selection spanning two messages offers no annotation', async ({ appPage }) => {
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  await expect(appPage.locator('.msg.assistant')).toContainText('second result')

  // Anchors are a single {messageId, start, end}; a range crossing a role
  // boundary cannot be described by one, so the affordance stays away rather
  // than silently annotating half of it.
  await appPage.evaluate(() => {
    const bodies = document.querySelectorAll('.msg .msg-body')
    const range = document.createRange()
    range.setStart(bodies[0], 0)
    range.setEnd(bodies[bodies.length - 1], 0)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  })
  await appPage.dispatchEvent('.messages', 'pointerup')

  await expect(appPage.locator('.annotation-popover')).toHaveCount(0)
})

test('the command palette opens from the keyboard and runs a command', async ({ appPage }) => {
  await appPage.keyboard.press('Control+k')
  const palette = appPage.getByRole('dialog', { name: 'Command palette' })
  await expect(palette).toBeVisible()
  const input = palette.getByRole('textbox', { name: 'Search commands' })
  await expect(input).toBeFocused()

  // The renderer shortcut and Electron menu accelerator both mean "open";
  // receiving both must not toggle the palette closed again.
  await appPage.keyboard.press('Control+k')
  await expect(palette).toBeVisible()
  await appPage.keyboard.press('Escape')
  await expect(palette).toHaveCount(0)
  await appPage.keyboard.press('Control+k')
  await expect(palette).toBeVisible()

  // Fuzzy, not substring: a dropped letter still finds the command.
  await input.fill('sttngs')
  await appPage.keyboard.press('Enter')

  await expect(palette).toHaveCount(0)
  await expect(appPage.locator('.settings-page')).toBeVisible()
  await appPage.getByRole('button', { name: 'Done' }).click()
  await expect(appPage.locator('.settings-page')).toHaveCount(0)

  // Escape dismisses the palette itself; it must not reach the app-level
  // handler that reads Escape as "abort the running thread".
  await appPage.keyboard.press('Control+k')
  await expect(palette).toBeVisible()
  await input.fill('nothing matches this query zzz')
  await expect(palette.getByText('No matches.')).toBeVisible()
  await appPage.keyboard.press('Escape')
  await expect(appPage.locator('.command-palette')).toHaveCount(0)
})

test('an attention event raises an unread badge that mark-all-read clears', async ({ appPage }) => {
  const bell = appPage.getByRole('button', { name: 'Activity' })
  await expect(bell.locator('.inbox-badge')).toHaveCount(0)

  await control(appPage).then((item) => item.emit({
    type: 'permission.asked',
    properties: {
      id: 'permission-inbox',
      sessionID: 'thread-source',
      permission: 'shell',
      patterns: ['npm test'],
      metadata: { command: 'npm test' }
    }
  }))

  await expect(bell.locator('.inbox-badge')).toHaveText('1')
  await bell.click()
  const panel = appPage.getByRole('dialog', { name: 'Activity' })
  await expect(panel).toBeVisible()
  const row = panel.locator('.inbox-row').filter({ hasText: 'Permission asked' })
  await expect(row).toContainText('Source thread')
  await expect(row).toContainText(/ago|just now/)

  // Click-through opens the thread the event came from.
  await row.click()
  await expect(panel).toHaveCount(0)
  await expect(appPage.locator('.workspace-tab.active').filter({ hasText: 'Source thread' })).toBeVisible()

  await control(appPage).then((item) => item.emit({
    type: 'permission.replied',
    properties: {
      sessionID: 'thread-source',
      permissionID: 'permission-inbox',
      response: 'once'
    }
  }))
  await expect(bell.locator('.inbox-badge')).toHaveText('2')

  // Visiting leaves both events unread, so the badge stands until read.
  await bell.click()
  await expect(panel.locator('.inbox-row').filter({ hasText: 'Permission answered' })).toBeVisible()
  await panel.getByRole('button', { name: 'Mark all read' }).click()
  await expect(bell.locator('.inbox-badge')).toHaveCount(0)

  // Main can forward the reply from an Auto/Plan permission whose request it
  // intentionally swallowed. With no matching prompt in renderer state, that
  // reply is not user activity and must not resurrect the badge.
  await control(appPage).then((item) => item.emit({
    type: 'permission.replied',
    properties: {
      sessionID: 'thread-source',
      permissionID: 'permission-auto',
      response: 'once'
    }
  }))
  await expect(bell.locator('.inbox-badge')).toHaveCount(0)
})

test('a base font size choice survives a reload and can be undone', async ({ appPage }) => {
  await openSettings(appPage)
  await appPage.getByRole('button', { name: 'Appearance' }).click()
  await appPage.getByLabel('Base font size').selectOption('large')
  await expect(appPage.locator('html')).toHaveAttribute('data-ui-font-size', 'large')

  await appPage.reload()
  await openSettings(appPage)
  await appPage.getByRole('button', { name: 'Appearance' }).click()
  await expect(appPage.getByLabel('Base font size')).toHaveValue('large')
  await expect(appPage.locator('html')).toHaveAttribute('data-ui-font-size', 'large')

  await appPage.getByLabel('Base font size').selectOption('default')
  await expect(appPage.locator('html')).not.toHaveAttribute('data-ui-font-size')
})

test('compact density reduces common chrome and survives a reload', async ({ appPage }) => {
  const toolbar = appPage.locator('.toolbar')
  const comfortableHeight = await toolbar.evaluate((element) => element.getBoundingClientRect().height)

  await openSettings(appPage)
  await appPage.getByRole('button', { name: 'Appearance' }).click()
  await appPage.getByLabel('UI density').selectOption('compact')
  await expect(appPage.locator('html')).toHaveAttribute('data-ui-density', 'compact')
  const compactHeight = await toolbar.evaluate((element) => element.getBoundingClientRect().height)
  expect(compactHeight).toBeLessThan(comfortableHeight)

  await appPage.reload()
  await openSettings(appPage)
  await appPage.getByRole('button', { name: 'Appearance' }).click()
  await expect(appPage.getByLabel('UI density')).toHaveValue('compact')
  await expect(appPage.locator('html')).toHaveAttribute('data-ui-density', 'compact')

  await appPage.getByLabel('UI density').selectOption('comfortable')
  await expect(appPage.locator('html')).not.toHaveAttribute('data-ui-density')
})

async function exportCalls(appPage: Parameters<typeof control>[0]): Promise<Array<Record<string, unknown>>> {
  const calls = await (await control(appPage)).calls()
  return calls
    .filter((call) => call.channel === 'export')
    .map((call) => call.request as Record<string, unknown>)
}

test('pinning a thread keeps it first across a reload', async ({ appPage }) => {
  const fixture = await control(appPage)
  const rows = appPage.locator('.sidebar-section.projects .session-row')
  const sourceRow = rows.filter({ hasText: 'Source thread' })
  await expect(sourceRow).toBeVisible()

  // Mid-list among the fixture threads rather than newest, so pinning must
  // move it above all of them, not merely keep its stored flag.
  await expect(rows.first()).toContainText('Claude stop thread')
  await expect(rows.last()).toContainText('Duplicate transcript')
  await fixture.holdNextPin()
  await sourceRow.getByRole('button', { name: 'Pin thread' }).click()

  expect((await lastBackendCall(appPage, 'thread.pin')).request).toEqual({
    type: 'thread.pin',
    threadId: 'thread-source',
    pinned: true
  })
  await expect(rows.first()).toContainText('Source thread')
  const pinnedButton = sourceRow.getByRole('button', { name: 'Unpin thread' })
  await expect(pinnedButton).toBeVisible()
  await expect(pinnedButton).toHaveClass(/\bpinned\b/)

  // A session refresh can finish while main is still saving the pin. It must
  // not overwrite the optimistic choice with its older session snapshot.
  const listsBefore = (await backendCalls(appPage, 'thread.list')).length
  await fixture.emit({ type: 'session.updated', properties: { info: { id: 'thread-source' } } })
  await expect.poll(async () => (await backendCalls(appPage, 'thread.list')).length).toBeGreaterThan(listsBefore)
  await expect(rows.first()).toContainText('Source thread')
  await expect(pinnedButton).toHaveClass(/\bpinned\b/)
  await fixture.releasePin()
  await expect.poll(async () => (await fixture.sessions()).find((session) => session.id === 'thread-source')?.pinned).toBe(true)

  // The pin lives on the thread, so a reload reads it back rather than losing
  // it — the contract main keeps in backend-threads.json.
  await appPage.reload()
  const reloadedRows = appPage.locator('.sidebar-section.projects .session-row')
  await expect(reloadedRows.first()).toContainText('Source thread')
  await expect(reloadedRows.first().getByRole('button', { name: 'Unpin thread' })).toBeVisible()
})

test('thread rows and Command Center cards export the transcript as Markdown', async ({ appPage }) => {
  const sourceRow = appPage.locator('.session-row').filter({ hasText: 'Source thread' })
  await expect(sourceRow).toBeVisible()
  await sourceRow.click({ button: 'right' })
  await appPage.getByRole('button', { name: 'Export as Markdown…' }).click()

  await expect.poll(async () => (await exportCalls(appPage)).length).toBeGreaterThanOrEqual(1)
  const [fromRow] = await exportCalls(appPage)
  expect(fromRow).toMatchObject({ title: 'Source thread', defaultName: 'source-thread.md' })
  const markdown = String(fromRow.markdown)
  assert.ok(markdown.startsWith('# Source thread'), 'the file should carry the thread title as its heading')
  assert.ok(markdown.includes('### User'), 'user turns should be labelled')
  assert.ok(markdown.includes('Search marker: first result.'), 'the user message should be in the file')

  // The same action hangs off Command Center's attention cards, which have no
  // context menu of their own otherwise.
  const card = appPage.locator('.command-session-card').filter({ hasText: 'Source thread' })
  await expect(card).toBeVisible()
  await card.click({ button: 'right' })
  await appPage.getByRole('button', { name: 'Export as Markdown…' }).click()

  await expect.poll(async () => (await exportCalls(appPage)).length).toBe(2)

  // A save-dialog or disk failure must be visible even while Command Center,
  // rather than a hidden error that appears only after opening a chat.
  await (await control(appPage)).failNextExport('The export disk is full.')
  await sourceRow.click({ button: 'right' })
  await appPage.getByRole('button', { name: 'Export as Markdown…' }).click()
  await expect(appPage.getByRole('heading', { name: 'Export failed' })).toBeVisible()
  await expect(appPage.locator('.modal .body')).toHaveText('Error: The export disk is full.')
})

test('the composer meter reports what backends recorded and hides when they report nothing', async ({ appPage }) => {
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()

  // Only reported numbers: the fixture's source thread has recorded tokens,
  // so the meter shows them compactly beside the composer controls.
  const meter = appPage.locator('.token-meter-toggle:visible')
  await expect(meter).toBeVisible()
  await expect(meter).toContainText(/12\.4K tok/)
  await expect(meter).toContainText('4 runs')

  await meter.click()
  const detail = appPage.getByLabel('Token usage detail')
  await expect(detail).toBeVisible()
  await expect(detail).toContainText('12.4K across 3 runs')
  await expect(detail).toContainText('Only tokens the backend reports are counted.')

  // A thread whose backend never reported anything shows no meter at all —
  // not a row of zeros. The previous thread's tab stays mounted but hidden,
  // so this is about visible meters.
  await appPage.locator('.session-row').filter({ hasText: 'Claude stop thread' }).click()
  await expect(appPage.locator('.token-meter-toggle:visible')).toHaveCount(0)
})

/** Open the review surface for the source thread's checkout. */
async function openReviewTab(page: Parameters<typeof control>[0]): Promise<void> {
  await page.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  await page.locator('.workspace-tab-add-inline[title="Add a terminal, files or review to this thread"]').click()
  await page.locator('.workspace-add-menu-item').filter({ hasText: 'Review' }).click()
}

test('the diff view toggles between unified and split and remembers it', async ({ appPage }) => {
  await openReviewTab(appPage)

  // Pick the tracked file: Working tree also includes the fixture's new,
  // untracked file, which has its own card.
  const card = appPage.locator('.diff-card').filter({ hasText: 'src/edited.ts' })
  await expect(card).toHaveCount(1)
  const view = card.locator('.diff-view')
  await expect(view).toHaveAttribute('data-mode', 'unified')

  await expect(view.locator('.word-del')).toContainText('total')
  await expect(view.locator('.word-add')).toContainText('sum')

  const toggle = appPage.getByRole('group', { name: 'Diff layout' })
  await toggle.getByRole('button', { name: 'Split' }).click()
  await expect(view).toHaveAttribute('data-mode', 'split')

  // Two gutters side by side inside the one file block: the modified pair sits
  // on one row, old left and new right, each carrying its own word mark.
  const row = view.locator('.diff-split-row:has(.word-del)').first()
  await expect(row.locator('.diff-line.half')).toHaveCount(2)
  await expect(row.locator('.diff-line.half.left')).toContainText('total')
  await expect(row.locator('.diff-line.half.right')).toContainText('sum')
  await expect(card.locator('.diff-line.hunk.span')).toHaveCount(1)

  await expect.poll(() => appPage.evaluate(() => localStorage.getItem('boss.diffMode'))).toBe('split')

  // The choice survives leaving and re-entering the workspace: a fresh
  // DiffReview reads it back when it mounts.
  await appPage.reload()
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  await appPage.locator('.workspace-tab').filter({ hasText: 'Review' }).click()
  await expect(appPage.locator('.diff-view.split').first()).toBeVisible()

  await appPage.getByRole('group', { name: 'Diff layout' }).getByRole('button', { name: 'Unified' }).click()
  await expect(appPage.locator('.diff-view[data-mode="unified"]').first()).toBeVisible()
})

test('the whitespace toggle is offered on the diff toolbar and persists', async ({ appPage }) => {
  await openReviewTab(appPage)
  await expect(appPage.locator('.diff-card')).toHaveCount(2)

  const whitespace = appPage.locator('.diff-whitespace-toggle')
  await expect(whitespace).toHaveText('Ignore whitespace')
  await expect(whitespace).toHaveAttribute('aria-pressed', 'false')
  await whitespace.click()
  await expect(whitespace).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => appPage.evaluate(() => localStorage.getItem('boss.diffIgnoreWhitespace'))).toBe('1')

  // A freshly mounted diff reads the preference back.
  await appPage.reload()
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  await appPage.locator('.workspace-tab').filter({ hasText: 'Review' }).click()
  await expect(appPage.locator('.diff-whitespace-toggle')).toHaveAttribute('aria-pressed', 'true')
})

test('review scopes expose untracked, staged, and committed branch changes in a responsive toolbar', async ({ appPage }) => {
  await appPage.setViewportSize({ width: 760, height: 700 })
  await openReviewTab(appPage)

  const paths = appPage.locator('.diff-file-path')
  await expect(paths).toHaveText(['src/edited.ts', 'scratch.ts'])

  const scopes = appPage.getByRole('tablist', { name: 'Review scope' })
  await scopes.getByRole('tab', { name: 'Staged' }).click()
  await expect(paths).toHaveText(['src/staged.ts'])

  await scopes.getByRole('tab', { name: 'Compare' }).click()
  await expect(appPage.getByRole('combobox', { name: 'Compare against' })).toHaveValue('origin/main')
  await expect(paths).toHaveText(['src/committed.ts'])

  // The checkout controls live on their own semantic row and both toolbars
  // contain their controls at a normal split-pane width instead of spilling
  // over the review content.
  await expect(appPage.getByRole('group', { name: 'Checkout branch' })).toBeVisible()
  await expect(appPage.getByRole('group', { name: 'Diff options' })).toBeVisible()
  await expect.poll(() => appPage.locator('.git-toolbar').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  await expect.poll(() => appPage.locator('.diff-stack-head').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
})

test('committing stages a chosen subset and commits only it', async ({ appPage }) => {
  // The row labels projects by folder name; its title carries the full path.
  const project = appPage.locator('.sidebar-section.projects .project-row[title="/tmp/boss-e2e/project"]')
  await expect(project).toBeVisible()
  await project.click({ button: 'right' })
  await appPage.getByRole('button', { name: 'Commit & push…' }).click()

  const dialog = appPage.locator('.modal')
  const staged = dialog.locator('.commit-section.staged')
  const unstaged = dialog.locator('.commit-section.unstaged')
  await expect(staged).toContainText('src/staged.ts')
  await expect(unstaged).toContainText('src/edited.ts')
  await expect(unstaged).toContainText('scratch.ts')

  // Nothing staged means nothing to commit: the buttons stand down, and the
  // labels lose their counts.
  await dialog.getByRole('button', { name: 'Unstage src/staged.ts' }).click()
  await expect(dialog.getByRole('button', { name: 'Commit', exact: true })).toBeDisabled()

  // Recording starts here, so everything below is asserted against the exact
  // git traffic this test caused.
  const e2e = await control(appPage)
  await e2e.resetCalls()
  await dialog.locator('.commit-input').fill('Just the scratch file')
  await e2e.holdGit('add')
  await dialog.getByRole('button', { name: 'Stage scratch.ts' }).click()
  const commitButton = dialog.getByRole('button', { name: 'Commit (1)', exact: true })
  // The optimistic row move must not let Commit or another toggle overtake the
  // still-running git add.
  await expect.poll(async () => gitCalls(appPage).then((calls) => calls.some((args) => args[0] === 'add'))).toBe(true)
  await expect(commitButton).toBeDisabled()
  await expect(dialog.getByRole('button', { name: 'Stage src/edited.ts' })).toBeDisabled()
  await e2e.releaseGit('add')
  await expect(commitButton).toBeEnabled()
  await commitButton.click()

  await expect(dialog.locator('.commit-output')).toContainText('Committed ✓')
  // Exactly one targeted add — no sweep of everything with -A.
  await expect.poll(async () => gitCalls(appPage).then((calls) => calls.filter((args) => args[0] === 'add'))).toEqual([['add', '--', 'scratch.ts']])
  const calls = await gitCalls(appPage)
  expect(calls).toContainEqual(['commit', '-m', 'Just the scratch file'])
  expect(calls.some((args) => args.includes('-A'))).toBe(false)
})

test('branch switching blocks conflicts and restores a targeted stash on a safe branch', async ({ appPage }) => {
  await openReviewTab(appPage)
  const branch = appPage.getByRole('combobox', { name: 'Switch branch' })
  await expect(branch).toBeEnabled()
  await expect(branch).toHaveValue('main')

  // The fixture's conflict branch changes src/edited.ts, which is also dirty
  // locally. The guard must stop before checkout.
  await branch.selectOption('conflict')
  const blocked = appPage.locator('.modal').filter({ hasText: "Can't switch to conflict" })
  await expect(blocked).toContainText('src/edited.ts')
  await blocked.getByRole('button', { name: 'Stay' }).click()
  await expect(branch).toHaveValue('main')

  await control(appPage).then((item) => item.resetCalls())
  await branch.selectOption('feature')
  const confirm = appPage.locator('.modal').filter({ hasText: 'Switch to feature?' })
  await confirm.getByRole('button', { name: 'Stash & switch' }).click()
  await expect(branch).toHaveValue('feature')

  const calls = await gitCalls(appPage)
  expect(calls).toContainEqual(['stash', 'push', '--include-untracked', '-m', 'BOSS branch switch'])
  expect(calls).toContainEqual(['checkout', 'feature'])
  expect(calls).toContainEqual(['stash', 'pop', 'stash@{0}'])

  // Restoration is observable in the UI too: the feature checkout still has
  // the same local working-tree change after the targeted stash is popped.
  await expect(appPage.locator('.diff-card-path').filter({ hasText: 'src/edited.ts' })).toHaveCount(1)

  // Reproduce the confirmation-time race: after BOSS planned a stash switch,
  // another Git client stashes the changes first. Revalidation must switch the
  // now-clean tree directly and leave that pre-existing stash untouched.
  await branch.selectOption('main')
  const back = appPage.locator('.modal').filter({ hasText: 'Switch to main?' })
  await expect(back).toBeVisible()
  await appPage.evaluate(() => (window as unknown as { boss: BossApi }).boss.gitRun('/tmp/boss-e2e/project/checkout', ['stash', 'push', '--include-untracked', '-m', 'manual existing stash']))
  await control(appPage).then((item) => item.resetCalls())
  await back.getByRole('button', { name: 'Stash & switch' }).click()
  await expect(branch).toHaveValue('main')
  const retryCalls = await gitCalls(appPage)
  expect(retryCalls.some((args) => args[0] === 'stash')).toBe(false)
  const existing = await appPage.evaluate(() => (window as unknown as { boss: BossApi }).boss.gitRun('/tmp/boss-e2e/project/checkout', ['rev-parse', '--verify', 'refs/stash']))
  expect(existing.code).toBe(0)
})

test('a fenced code block in chat highlights and copies raw code', async ({ appPage }) => {
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()

  const block = appPage.locator('.md .code-block').first()
  await expect(block.locator('span.hljs-keyword')).toHaveText('const')

  // The label is the button text, which reads Copy before it flips to Copied.
  const copy = block.locator('.code-copy')
  await expect(copy).toHaveAccessibleName('Copy')
  await copy.click()
  await expect(copy).toHaveText(/Copied/)

  // The clipboard carries the raw code, never the highlight markup.
  const writes = await control(appPage).then((item) => item.clipboardWrites())
  expect(writes.at(-1)).toBe('const answer = 42\nconsole.log(answer)')
})

test('compact asks before summarizing and then compacts the thread', async ({ appPage }) => {
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  await expect(appPage.locator('.msg.assistant')).toContainText('second result')

  const menu = appPage.locator('.ctx-menu')
  const compactItem = menu.getByRole('button', { name: 'Compact context…' })

  // Cancel keeps the transcript untouched.
  await appPage.locator('.msg.user .msg-more').first().click()
  await compactItem.click()
  const modal = appPage.locator('.modal-backdrop')
  await expect(modal.getByRole('heading', { name: 'Compact this thread?' })).toBeVisible()
  await modal.getByRole('button', { name: 'Cancel' }).click()
  await expect(modal).toHaveCount(0)

  await control(appPage).then((item) => item.resetCalls())
  await appPage.locator('.msg.user .msg-more').first().click()
  await compactItem.click()
  await modal.getByRole('button', { name: 'Compact' }).click()
  expect((await lastBackendCall(appPage, 'thread.compact')).request).toMatchObject({
    type: 'thread.compact',
    threadId: 'thread-source'
  })
  await expect(appPage.locator('.msg.assistant .msg-body')).toHaveText('Compacted context summary.')
  await expect(appPage.locator('.messages')).not.toContainText('second result')
})

test('undo to here reverts on an opencode thread and restores again', async ({ appPage }) => {
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  await expect(appPage.locator('.msg.assistant')).toContainText('second result')
  await control(appPage).then((item) => item.resetCalls())

  const more = appPage.locator('.msg.assistant .msg-more').last()
  const menu = appPage.locator('.ctx-menu')

  await more.click()
  await menu.getByRole('button', { name: 'Undo to here' }).click()
  expect((await lastBackendCall(appPage, 'thread.revert')).request).toMatchObject({
    type: 'thread.revert',
    threadId: 'thread-source',
    messageId: 'source-search-agent'
  })
  await expect(appPage.locator('.msg.assistant')).toHaveCount(0)

  await appPage.locator('.msg.user .msg-more').click()
  await menu.getByRole('button', { name: 'Restore undone messages' }).click()
  expect((await lastBackendCall(appPage, 'thread.unrevert')).request).toMatchObject({
    type: 'thread.unrevert',
    threadId: 'thread-source'
  })
  await expect(appPage.locator('.msg.assistant')).toContainText('second result')
})

test('history controls stay hidden when the backend cannot perform them', async ({ appPage }) => {
  await appPage.locator('.session-row').filter({ hasText: 'Claude stop thread' }).click()
  await expect(appPage.locator('.msg.assistant')).toContainText('Claude history controls are unavailable.')

  await appPage.locator('.msg.assistant .msg-more').click()
  const menu = appPage.locator('.ctx-menu')
  await expect(menu.getByRole('button', { name: 'Undo to here' })).toHaveCount(0)
  await expect(menu.getByRole('button', { name: 'Restore undone messages' })).toHaveCount(0)
  await expect(menu.getByRole('button', { name: 'Compact context…' })).toHaveCount(0)
})

test('a failed undo leaves the transcript and restore state unchanged', async ({ appPage }) => {
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  await expect(appPage.locator('.msg.assistant')).toContainText('second result')
  await control(appPage).then((item) => item.failNextBackendRequest('thread.revert', 'Fixture revert failed.'))

  await appPage.locator('.msg.assistant .msg-more').click()
  await appPage.locator('.ctx-menu').getByRole('button', { name: 'Undo to here' }).click()

  await expect(appPage.locator('.chat-error')).toContainText('Fixture revert failed.')
  await expect(appPage.locator('.msg.assistant')).toContainText('second result')
  await appPage.locator('.msg.assistant .msg-more').click()
  await expect(appPage.locator('.ctx-menu').getByRole('button', { name: 'Restore undone messages' })).toHaveCount(0)
})

test('a failed restore keeps the undone transcript restorable', async ({ appPage }) => {
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  await expect(appPage.locator('.msg.assistant')).toContainText('second result')

  await appPage.locator('.msg.assistant .msg-more').click()
  await appPage.locator('.ctx-menu').getByRole('button', { name: 'Undo to here' }).click()
  await expect(appPage.locator('.msg.assistant')).toHaveCount(0)
  await control(appPage).then((item) => item.failNextBackendRequest('thread.unrevert', 'Fixture restore failed.'))

  await appPage.locator('.msg.user .msg-more').click()
  await appPage.locator('.ctx-menu').getByRole('button', { name: 'Restore undone messages' }).click()

  await expect(appPage.locator('.chat-error')).toContainText('Fixture restore failed.')
  await expect(appPage.locator('.msg.assistant')).toHaveCount(0)
  await appPage.locator('.msg.user .msg-more').click()
  await expect(appPage.locator('.ctx-menu').getByRole('button', { name: 'Restore undone messages' })).toBeVisible()
})

test('reading a reply aloud swaps its speaker button for a stop control', async ({ appPage }) => {
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  await expect(appPage.locator('.msg.assistant')).toContainText('second result')

  const actions = appPage.locator('.msg.assistant .msg-actions')
  await actions.getByRole('button', { name: 'Read aloud' }).click()

  const stop = actions.getByRole('button', { name: 'Stop reading' })
  await expect(stop).toBeVisible()
  await stop.click()

  await expect(actions.getByRole('button', { name: 'Read aloud' })).toBeVisible()
})

test('retry resends the prompt that produced a finished reply', async ({ appPage }) => {
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  await expect(appPage.locator('.msg.assistant')).toContainText('second result')
  await control(appPage).then((item) => item.resetCalls())

  await appPage.locator('.msg.assistant').getByRole('button', { name: 'Retry this turn' }).click()

  const call = await lastBackendCall(appPage, 'thread.send')
  expect(call.request).toMatchObject({ type: 'thread.send', threadId: 'thread-source' })
  const text = (call.request as { parts: { type: string; text?: string }[] }).parts
    .find((part) => part.type === 'text')?.text ?? ''
  expect(text).toBe('Search marker: first result.')
  const file = (call.request as { parts: { type: string; mime?: string; filename?: string; url?: string }[] }).parts
    .find((part) => part.type === 'file')
  expect(file).toMatchObject({
    type: 'file',
    mime: 'image/png',
    filename: 'source.png',
    url: 'data:image/png;base64,AAAA'
  })
})

test('automatic compaction is visible while it runs and remains in the transcript', async ({ appPage }) => {
  const sessionID = 'thread-source'
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()

  await control(appPage).then((item) => item.emit({
    type: 'session.compaction.started',
    properties: { sessionID, trigger: 'auto' }
  }))
  await expect(appPage.locator('.thinking-indicator')).toContainText('Compacting context')
  await expect(
    appPage.locator('.session-row').filter({ hasText: 'Source thread' }).locator('.session-state.compacting')
  ).toHaveAttribute('title', 'Compacting')

  const messageID = 'compaction-notice-e2e'
  const created = Date.now()
  await control(appPage).then((item) => item.emit({
    type: 'message.updated',
    properties: { info: { id: messageID, sessionID, role: 'user', time: { created, completed: created } } }
  }))
  await control(appPage).then((item) => item.emit({
    type: 'message.part.updated',
    properties: {
      part: {
        id: `${messageID}-part`,
        type: 'compaction',
        sessionID,
        messageID,
        auto: true,
        state: { status: 'completed', metadata: { trigger: 'auto', preTokens: 180_000, postTokens: 24_000 } }
      }
    }
  }))
  await control(appPage).then((item) => item.emit({
    type: 'session.compacted',
    properties: { sessionID, trigger: 'auto', preTokens: 180_000, postTokens: 24_000 }
  }))

  await expect(appPage.locator('.thinking-indicator')).toHaveCount(0)
  const notice = appPage.locator('.compaction-divider-label')
  await expect(notice).toHaveText('Context compacted automatically — earlier messages were summarized. 180K → 24K tokens.')

  // Completion reloads native history. The marker must survive that reload and
  // revisiting the thread, or background compaction remains easy to miss.
  await appPage.locator('.session-row').filter({ hasText: 'Duplicate transcript' }).click()
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  await expect(notice).toHaveText('Context compacted automatically — earlier messages were summarized. 180K → 24K tokens.')
})

test('a failed automatic compaction clears progress and reports the reason', async ({ appPage }) => {
  const sessionID = 'thread-source'
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()

  await control(appPage).then((item) => item.emit({
    type: 'session.compaction.started',
    properties: { sessionID, trigger: 'auto' }
  }))
  await expect(appPage.locator('.thinking-indicator')).toContainText('Compacting context')

  await control(appPage).then((item) => item.emit({
    type: 'session.error',
    properties: { sessionID, error: 'The context could not be compacted.' }
  }))

  await expect(appPage.locator('.thinking-indicator')).toHaveCount(0)
  await expect(appPage.locator('.chat-error')).toContainText('The context could not be compacted.')
  await expect(appPage.locator('.session-row').filter({ hasText: 'Source thread' })).not.toContainText('Compacting')
})
